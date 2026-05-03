import {
  generateDeviceKeyPair,
  hasSharedPrivateKeyMaterial,
  type SharedActorKeyMaterial,
  type DeviceKeyShareSnapshot,
} from '../../../shared/device-sharing';
import type { ActorIdentity, AgentKeyPair } from '../../../shared/agent-crypto';
import type { ResolvedProfile } from './config-store';
import { userError } from './errors';
import type {
  DeviceKeyMaterial,
  NamespaceKeyVault,
  SecretStore,
} from './secret-store';

function buildDefaultActorIdentity(profile: ResolvedProfile): ActorIdentity | null {
  const snapshot = profile.bootstrapSnapshot;
  if (!snapshot) {
    return null;
  }

  return {
    email: snapshot.inbox.email,
    slug: snapshot.actor.slug,
  };
}

function dedupeArchivedKeyPairs(pairs: AgentKeyPair[]): AgentKeyPair[] {
  const seen = new Set<string>();
  const next: AgentKeyPair[] = [];

  for (const pair of pairs) {
    const key = `${pair.encryption.keyVersion}:${pair.signing.keyVersion}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(pair);
  }

  return next;
}

function cloneSharedActorKeyMaterial(actor: SharedActorKeyMaterial): SharedActorKeyMaterial {
  return {
    identity: {
      email: actor.identity.email,
      slug: actor.identity.slug,
      accountIdentifier: actor.identity.accountIdentifier,
    },
    current: actor.current
      ? {
          encryption: { ...actor.current.encryption },
          signing: { ...actor.current.signing },
        }
      : null,
    archived: actor.archived.map(pair => ({
      encryption: { ...pair.encryption },
      signing: { ...pair.signing },
    })),
  };
}

function buildSnapshot(email: string, actors: SharedActorKeyMaterial[]): DeviceKeyShareSnapshot {
  return {
    version: 1,
    email,
    createdAt: new Date().toISOString(),
    actors,
  };
}

function mergeOverrideActors(params: {
  email: string;
  existingActors: SharedActorKeyMaterial[];
  overrides?: SharedActorKeyMaterial[];
}): SharedActorKeyMaterial[] {
  const overrideBySlug = new Map(
    (params.overrides ?? [])
      .filter(override => override.identity.email === params.email)
      .map(override => [override.identity.slug, override] as const)
  );

  const actors = params.existingActors.map(actor => {
    const override = overrideBySlug.get(actor.identity.slug);
    if (!override) {
      return cloneSharedActorKeyMaterial(actor);
    }

    overrideBySlug.delete(actor.identity.slug);
    return cloneSharedActorKeyMaterial(override);
  });

  for (const override of overrideBySlug.values()) {
    actors.push(cloneSharedActorKeyMaterial(override));
  }

  return actors;
}

function selectOverrideActors(overrides?: SharedActorKeyMaterial[]): SharedActorKeyMaterial[] {
  const email = overrides?.find(override => {
    return Boolean(override.current) || override.archived.length > 0;
  })?.identity.email;

  if (!email) {
    return [];
  }

  return (overrides ?? [])
    .filter(override => override.identity.email === email)
    .map(cloneSharedActorKeyMaterial);
}

export async function getOrCreateCliDeviceKeyMaterial(
  profileName: string,
  secretStore: SecretStore
): Promise<DeviceKeyMaterial> {
  const existing = await secretStore.getDeviceKeyMaterial(profileName);
  if (existing) {
    return existing;
  }

  const created: DeviceKeyMaterial = {
    deviceId: crypto.randomUUID(),
    keyPair: await generateDeviceKeyPair(),
  };
  await secretStore.setDeviceKeyMaterial(profileName, created);
  return created;
}

export async function ensureNamespaceVaultContainsDefaultActor(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  keyPair: AgentKeyPair;
}): Promise<void> {
  const identity = buildDefaultActorIdentity(params.profile);
  if (!identity) {
    return;
  }

  const existingVault = await params.secretStore.getNamespaceKeyVault(params.profile.name);
  const actors = existingVault?.actors ?? [];
  const existingActorIndex = actors.findIndex(actor => actor.identity.slug === identity.slug);
  const nextActor = {
    identity,
    current: params.keyPair,
    archived:
      existingActorIndex >= 0
        ? dedupeArchivedKeyPairs(actors[existingActorIndex]?.archived ?? [])
        : [],
  };
  const nextActors =
    existingActorIndex >= 0
      ? actors.map((actor, index) => (index === existingActorIndex ? nextActor : actor))
      : [...actors, nextActor];

  await params.secretStore.setNamespaceKeyVault(params.profile.name, {
    version: 1,
    email: identity.email,
    actors: nextActors,
  });
}

export async function exportNamespaceKeyShareSnapshot(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  overrides?: SharedActorKeyMaterial[];
}): Promise<DeviceKeyShareSnapshot> {
  const existingVault = await params.secretStore.getNamespaceKeyVault(params.profile.name);
  if (existingVault) {
    const snapshot = buildSnapshot(
      existingVault.email,
      mergeOverrideActors({
        email: existingVault.email,
        existingActors: existingVault.actors,
        overrides: params.overrides,
      })
    );
    if (hasSharedPrivateKeyMaterial(snapshot)) {
      return snapshot;
    }
  }

  const overrideActors = selectOverrideActors(params.overrides);
  if (overrideActors.length > 0) {
    return buildSnapshot(overrideActors[0].identity.email, overrideActors);
  }

  const defaultIdentity = buildDefaultActorIdentity(params.profile);
  const defaultKeyPair = await params.secretStore.getAgentKeyPair(params.profile.name);
  if (!defaultIdentity || !defaultKeyPair) {
    throw userError(
      'No local private key material is available to share from this CLI profile.',
      { code: 'DEVICE_SHARE_KEYS_UNAVAILABLE' }
    );
  }

  const overrideActor = (params.overrides ?? []).find(
    override =>
      override.identity.email === defaultIdentity.email &&
      override.identity.slug === defaultIdentity.slug
  );

  return buildSnapshot(defaultIdentity.email, [
    cloneSharedActorKeyMaterial(
      overrideActor ?? {
        identity: defaultIdentity,
        current: defaultKeyPair,
        archived: [],
      }
    ),
  ]);
}

export async function importNamespaceKeyShareSnapshot(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  snapshot: DeviceKeyShareSnapshot;
}): Promise<void> {
  const nextVault: NamespaceKeyVault = {
    version: 1,
    email: params.snapshot.email,
    actors: params.snapshot.actors,
  };
  await params.secretStore.setNamespaceKeyVault(params.profile.name, nextVault);

  const preferredSlug = params.profile.bootstrapSnapshot?.actor.slug;
  const preferredActor =
    nextVault.actors.find(actor => actor.identity.slug === preferredSlug && actor.current) ??
    nextVault.actors.find(actor => !actor.identity.accountIdentifier && actor.current) ??
    nextVault.actors.find(actor => actor.current);

  if (preferredActor?.current) {
    await params.secretStore.setAgentKeyPair(params.profile.name, preferredActor.current);
  }
}
