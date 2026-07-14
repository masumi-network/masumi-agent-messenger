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

function mergeSharedActorMaterial(
  existing: SharedActorKeyMaterial | null,
  imported: SharedActorKeyMaterial
): SharedActorKeyMaterial {
  const current = imported.current ?? existing?.current ?? null;
  const archiveExistingCurrent =
    existing?.current && (!current || !sameKeyPair(existing.current, current))
      ? [existing.current]
      : [];
  const archived = dedupeArchivedKeyPairs([
    ...(existing?.archived ?? []),
    ...imported.archived,
    ...archiveExistingCurrent,
  ]).filter(pair => !current || !sameKeyPair(pair, current));

  return cloneSharedActorKeyMaterial({
    identity: imported.identity,
    current,
    archived,
  });
}

function mergeImportedActors(params: {
  existingActors: SharedActorKeyMaterial[];
  importedActors: SharedActorKeyMaterial[];
}): SharedActorKeyMaterial[] {
  const actorsBySlug = new Map(
    params.existingActors.map(actor => [
      actor.identity.slug,
      cloneSharedActorKeyMaterial(actor),
    ] as const)
  );

  for (const imported of params.importedActors) {
    actorsBySlug.set(
      imported.identity.slug,
      mergeSharedActorMaterial(actorsBySlug.get(imported.identity.slug) ?? null, imported)
    );
  }

  return Array.from(actorsBySlug.values()).filter(
    actor => Boolean(actor.current) || actor.archived.length > 0
  );
}

function buildSnapshot(email: string, actors: SharedActorKeyMaterial[]): DeviceKeyShareSnapshot {
  return {
    version: 1,
    email,
    createdAt: new Date().toISOString(),
    actors,
  };
}

/**
 * Repair legacy vault rows whose `identity.email` is missing or empty (written
 * by older CLI versions for slug-only agents). Every actor in a namespace vault
 * belongs to the vault's account, so inheriting the vault email is always
 * correct — and without it a single legacy row makes `account backup export`
 * and device key-sharing fail for the whole account with
 * "actors[N].identity.email must be a string".
 */
function normalizeVaultActorIdentities(
  vaultEmail: string,
  actors: SharedActorKeyMaterial[]
): SharedActorKeyMaterial[] {
  return actors.map(actor => {
    const email = actor.identity.email as string | undefined;
    if (typeof email === 'string' && email.trim() !== '') {
      return actor;
    }
    return {
      ...actor,
      identity: { ...actor.identity, email: vaultEmail },
    };
  });
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
  const existingActor = existingActorIndex >= 0 ? actors[existingActorIndex] : null;
  const nextActor = {
    identity,
    current: params.keyPair,
    archived: dedupeArchivedKeyPairs([
      ...(existingActor?.archived ?? []),
      ...(existingActor?.current && !sameKeyPair(existingActor.current, params.keyPair)
        ? [existingActor.current]
        : []),
    ]).filter(pair => !sameKeyPair(pair, params.keyPair)),
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
  await params.secretStore.setAgentKeyPair(params.profile.name, params.keyPair);
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
        existingActors: normalizeVaultActorIdentities(existingVault.email, existingVault.actors),
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
  const existingVault = await params.secretStore.getNamespaceKeyVault(params.profile.name);
  const nextVault: NamespaceKeyVault = {
    version: 1,
    email: params.snapshot.email,
    actors: mergeImportedActors({
      existingActors:
        existingVault?.email === params.snapshot.email ? existingVault.actors : [],
      importedActors: params.snapshot.actors,
    }),
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
