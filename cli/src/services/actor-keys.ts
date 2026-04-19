import {
  generateAgentKeyPair,
  nextKeyVersion,
  type ActorIdentity,
  type AgentKeyPair,
} from '../../../shared/agent-crypto';
import type { SharedActorKeyMaterial } from '../../../shared/device-sharing';
import type { ResolvedProfile } from './config-store';
import type { NamespaceKeyVault, SecretStore } from './secret-store';

export type StoredActorKeyRotationPlan = {
  rotated: AgentKeyPair;
  nextVault: NamespaceKeyVault;
};

export type PublishedActorKeyBundle = {
  encryption: {
    publicKey: string;
    keyVersion: string;
  };
  signing: {
    publicKey: string;
    keyVersion: string;
  };
};

export type StoredActorKeyPairResolution =
  | {
      status: 'matched';
      keyPair: AgentKeyPair;
    }
  | {
      status: 'missing' | 'mismatch';
      keyPair: null;
    };

function buildDefaultActorIdentity(profile: ResolvedProfile): ActorIdentity | null {
  const snapshot = profile.bootstrapSnapshot;
  if (!snapshot) {
    return null;
  }

  return {
    normalizedEmail: snapshot.inbox.normalizedEmail,
    slug: snapshot.actor.slug,
  };
}

function isDefaultProfileActor(profile: ResolvedProfile, identity: ActorIdentity): boolean {
  const defaultIdentity = buildDefaultActorIdentity(profile);
  return Boolean(defaultIdentity && defaultIdentity.slug === identity.slug);
}

function buildEmptyVault(identity: ActorIdentity): NamespaceKeyVault {
  return {
    version: 1,
    normalizedEmail: identity.normalizedEmail,
    actors: [],
  };
}

function keyPairIdentity(pair: AgentKeyPair): string {
  return [
    pair.encryption.publicKey,
    pair.encryption.keyVersion,
    pair.signing.publicKey,
    pair.signing.keyVersion,
  ].join(':');
}

function sameKeyPair(left: AgentKeyPair, right: AgentKeyPair): boolean {
  return keyPairIdentity(left) === keyPairIdentity(right);
}

function matchesPublishedActorKeys(
  published: PublishedActorKeyBundle,
  pair: AgentKeyPair
): boolean {
  return (
    published.encryption.publicKey === pair.encryption.publicKey &&
    published.encryption.keyVersion === pair.encryption.keyVersion &&
    published.signing.publicKey === pair.signing.publicKey &&
    published.signing.keyVersion === pair.signing.keyVersion
  );
}

function dedupeArchivedKeyPairs(pairs: AgentKeyPair[]): AgentKeyPair[] {
  const seen = new Set<string>();
  const next: AgentKeyPair[] = [];

  for (const pair of pairs) {
    const key = keyPairIdentity(pair);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(pair);
  }

  return next;
}

function upsertVaultActor(params: {
  vault: NamespaceKeyVault;
  identity: ActorIdentity;
  current: AgentKeyPair | null;
  archiveCurrent: boolean;
}): NamespaceKeyVault {
  const actors = params.vault.actors;
  const actorIndex = actors.findIndex(actor => actor.identity.slug === params.identity.slug);
  const existing = actorIndex >= 0 ? actors[actorIndex] : null;
  const archived = dedupeArchivedKeyPairs([
    ...(params.archiveCurrent && existing?.current ? [existing.current] : []),
    ...(existing?.archived ?? []),
  ]);

  const nextActor: SharedActorKeyMaterial = {
    identity: params.identity,
    current: params.current,
    archived,
  };

  const nextActors =
    actorIndex >= 0
      ? actors.map((actor, index) => (index === actorIndex ? nextActor : actor))
      : [...actors, nextActor];

  return {
    ...params.vault,
    normalizedEmail: params.identity.normalizedEmail,
    actors: nextActors,
  };
}

function replaceVaultActor(params: {
  vault: NamespaceKeyVault;
  identity: ActorIdentity;
  current: AgentKeyPair | null;
  archived: AgentKeyPair[];
}): NamespaceKeyVault {
  const actorIndex = params.vault.actors.findIndex(actor => actor.identity.slug === params.identity.slug);
  const hasAnyPrivateKeyMaterial = Boolean(params.current) || params.archived.length > 0;

  if (!hasAnyPrivateKeyMaterial) {
    return {
      ...params.vault,
      normalizedEmail: params.identity.normalizedEmail,
      actors:
        actorIndex >= 0
          ? params.vault.actors.filter((_, index) => index !== actorIndex)
          : params.vault.actors,
    };
  }

  const nextActor: SharedActorKeyMaterial = {
    identity: params.identity,
    current: params.current,
    archived: params.archived,
  };

  return {
    ...params.vault,
    normalizedEmail: params.identity.normalizedEmail,
    actors:
      actorIndex >= 0
        ? params.vault.actors.map((actor, index) => (index === actorIndex ? nextActor : actor))
        : [...params.vault.actors, nextActor],
  };
}

export async function getStoredActorKeyPair(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
}): Promise<AgentKeyPair | null> {
  const vault = await params.secretStore.getNamespaceKeyVault(params.profile.name);
  const actor = vault?.actors.find(row => row.identity.slug === params.identity.slug);
  if (actor?.current) {
    return actor.current;
  }

  if (isDefaultProfileActor(params.profile, params.identity)) {
    return params.secretStore.getAgentKeyPair(params.profile.name);
  }

  return null;
}

export async function resolveStoredActorKeyPairForPublishedActor(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  published: PublishedActorKeyBundle;
}): Promise<StoredActorKeyPairResolution> {
  const existingVault =
    (await params.secretStore.getNamespaceKeyVault(params.profile.name)) ??
    buildEmptyVault(params.identity);
  const actor = existingVault.actors.find(row => row.identity.slug === params.identity.slug);
  const defaultKeyPair = isDefaultProfileActor(params.profile, params.identity)
    ? await params.secretStore.getAgentKeyPair(params.profile.name)
    : null;
  const hasActiveCandidate = Boolean(actor?.current || defaultKeyPair);
  const candidates = dedupeArchivedKeyPairs([
    ...(actor?.current ? [actor.current] : []),
    ...(defaultKeyPair ? [defaultKeyPair] : []),
    ...(actor?.archived ?? []),
  ]);
  const matched = candidates.find(pair => matchesPublishedActorKeys(params.published, pair)) ?? null;

  if (!matched) {
    if (candidates.length === 0) {
      return {
        status: 'missing',
        keyPair: null,
      };
    }

    const archived = dedupeArchivedKeyPairs(candidates);
    const nextVault = replaceVaultActor({
      vault: existingVault,
      identity: params.identity,
      current: null,
      archived,
    });
    await params.secretStore.setNamespaceKeyVault(params.profile.name, nextVault);

    if (isDefaultProfileActor(params.profile, params.identity)) {
      await params.secretStore.deleteAgentKeyPair(params.profile.name);
    }

    return {
      status: hasActiveCandidate ? 'mismatch' : 'missing',
      keyPair: null,
    };
  }

  const archived = dedupeArchivedKeyPairs(
    candidates.filter(candidate => !sameKeyPair(candidate, matched))
  );
  const nextVault = replaceVaultActor({
    vault: existingVault,
    identity: params.identity,
    current: matched,
    archived,
  });
  await params.secretStore.setNamespaceKeyVault(params.profile.name, nextVault);

  if (isDefaultProfileActor(params.profile, params.identity)) {
    await params.secretStore.setAgentKeyPair(params.profile.name, matched);
  }

  return {
    status: 'matched',
    keyPair: matched,
  };
}

export async function setStoredActorKeyPair(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
  archiveCurrent?: boolean;
}): Promise<void> {
  const existingVault =
    (await params.secretStore.getNamespaceKeyVault(params.profile.name)) ??
    buildEmptyVault(params.identity);
  const nextVault = upsertVaultActor({
    vault: existingVault,
    identity: params.identity,
    current: params.keyPair,
    archiveCurrent: params.archiveCurrent ?? false,
  });

  await params.secretStore.setNamespaceKeyVault(params.profile.name, nextVault);
  if (isDefaultProfileActor(params.profile, params.identity)) {
    await params.secretStore.setAgentKeyPair(params.profile.name, params.keyPair);
  }
}

async function buildNextVault(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
  archiveCurrent?: boolean;
}): Promise<NamespaceKeyVault> {
  const existingVault =
    (await params.secretStore.getNamespaceKeyVault(params.profile.name)) ??
    buildEmptyVault(params.identity);

  return upsertVaultActor({
    vault: existingVault,
    identity: params.identity,
    current: params.keyPair,
    archiveCurrent: params.archiveCurrent ?? false,
  });
}

export async function getOrCreateStoredActorKeyPair(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
}): Promise<AgentKeyPair> {
  const existing = await getStoredActorKeyPair(params);
  if (existing) {
    return existing;
  }

  const created = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  await setStoredActorKeyPair({
    ...params,
    keyPair: created,
  });
  return created;
}

export async function previewStoredActorKeyRotation(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  currentEncryptionKeyVersion: string;
  currentSigningKeyVersion: string;
}): Promise<StoredActorKeyRotationPlan> {
  const rotated = await generateAgentKeyPair({
    encryptionKeyVersion: nextKeyVersion(params.currentEncryptionKeyVersion, 'enc-v'),
    signingKeyVersion: nextKeyVersion(params.currentSigningKeyVersion, 'sig-v'),
  });
  const existing = await getStoredActorKeyPair(params);
  const nextVault = await buildNextVault({
    ...params,
    keyPair: rotated,
    archiveCurrent: Boolean(existing),
  });

  return {
    rotated,
    nextVault,
  };
}

export async function commitStoredActorKeyRotation(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  plan: StoredActorKeyRotationPlan;
}): Promise<void> {
  await params.secretStore.setNamespaceKeyVault(params.profile.name, params.plan.nextVault);
  if (isDefaultProfileActor(params.profile, params.identity)) {
    await params.secretStore.setAgentKeyPair(params.profile.name, params.plan.rotated);
  }
}

export async function rotateStoredActorKeyPair(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  identity: ActorIdentity;
  currentEncryptionKeyVersion: string;
  currentSigningKeyVersion: string;
}): Promise<AgentKeyPair> {
  const plan = await previewStoredActorKeyRotation(params);
  await commitStoredActorKeyRotation({
    profile: params.profile,
    secretStore: params.secretStore,
    identity: params.identity,
    plan,
  });
  return plan.rotated;
}
