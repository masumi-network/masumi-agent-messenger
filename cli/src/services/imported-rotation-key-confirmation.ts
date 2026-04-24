import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lock as acquireLock } from 'proper-lockfile';
import type { ActorIdentity, AgentKeyPair } from '../../../shared/agent-crypto';
import type { DeviceKeyShareSnapshot, SharedActorKeyMaterial } from '../../../shared/device-sharing';
import {
  confirmImportedRotationKeyInStore,
  emptyImportedRotationKeyConfirmationStore,
  getImportedRotationKeyConfirmationStatusFromStore,
  importedRotationActorKey,
  markImportedRotationSnapshotPendingInStore,
  parseImportedRotationKeyConfirmationStore,
  sameAgentKeyPairPublicTuple,
  type ImportedRotationKeyConfirmationStatus,
} from '../../../shared/imported-rotation-key-confirmation';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  loadProfile,
  resolveConfigDirectory,
  type ResolvedProfile,
} from './config-store';
import { userError } from './errors';
import {
  createSecretStore,
  type NamespaceKeyVault,
  type SecretStore,
} from './secret-store';

const STORE_FILE_NAME = 'imported-rotation-key-confirmations.json';
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_RETRIES = 10;
const STORE_LOCK_RETRY_MS = 100;

export type ConfirmCurrentImportedRotationKeyResult = {
  profile: string;
  slug: string;
  previousStatus: ImportedRotationKeyConfirmationStatus['status'];
};

function resolveStoreFilePath(): string {
  return path.join(resolveConfigDirectory(), STORE_FILE_NAME);
}

async function readStore() {
  const filePath = resolveStoreFilePath();
  try {
    const raw = await readFile(filePath, 'utf8');
    return parseImportedRotationKeyConfirmationStore(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyImportedRotationKeyConfirmationStore();
    }
    if (error instanceof SyntaxError || error instanceof Error) {
      throw userError('Imported rotation key confirmation store is corrupt.', {
        code: 'IMPORTED_ROTATION_KEY_CONFIRMATION_CORRUPT',
        cause: error,
      });
    }
    throw error;
  }
}

async function writeStore(store: ReturnType<typeof emptyImportedRotationKeyConfirmationStore>) {
  const filePath = resolveStoreFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

async function withStoreLock<T>(action: () => Promise<T>): Promise<T> {
  const filePath = resolveStoreFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });

  let release: () => Promise<void>;
  try {
    release = await acquireLock(filePath, {
      realpath: false,
      stale: STORE_LOCK_STALE_MS,
      update: 1000,
      retries: {
        retries: STORE_LOCK_RETRIES,
        factor: 1,
        minTimeout: STORE_LOCK_RETRY_MS,
        maxTimeout: STORE_LOCK_RETRY_MS,
      },
    });
  } catch (error) {
    throw userError('Imported rotation key confirmation store is busy. Try again in a moment.', {
      code: 'IMPORTED_ROTATION_KEY_CONFIRMATION_BUSY',
      cause: error,
    });
  }

  try {
    return await action();
  } finally {
    await release();
  }
}

function isDefaultProfileActor(profile: ResolvedProfile, identity: ActorIdentity): boolean {
  const snapshot = profile.bootstrapSnapshot;
  return Boolean(
    snapshot &&
      snapshot.inbox.normalizedEmail === identity.normalizedEmail &&
      normalizeInboxSlug(snapshot.actor.slug) === normalizeInboxSlug(identity.slug)
  );
}

function findVaultActor(
  vault: NamespaceKeyVault | null,
  identity: ActorIdentity
): SharedActorKeyMaterial | null {
  return (
    vault?.actors.find(actor => importedRotationActorKey(actor.identity) === importedRotationActorKey(identity)) ??
    null
  );
}

function findPreviousCurrentKeyPair(params: {
  profile: ResolvedProfile;
  previousVault: NamespaceKeyVault | null;
  previousDefaultKeyPair: AgentKeyPair | null;
  identity: ActorIdentity;
}): AgentKeyPair | null {
  const vaultActor = findVaultActor(params.previousVault, params.identity);
  if (vaultActor?.current) {
    return vaultActor.current;
  }
  if (isDefaultProfileActor(params.profile, params.identity)) {
    return params.previousDefaultKeyPair;
  }
  return null;
}

export async function markImportedRotationKeysPendingFromSnapshot(params: {
  profile: ResolvedProfile;
  secretStore: SecretStore;
  snapshot: DeviceKeyShareSnapshot;
  previousVault?: NamespaceKeyVault | null;
  previousDefaultKeyPair?: AgentKeyPair | null;
  now?: () => string;
}): Promise<number> {
  const previousVault =
    params.previousVault ?? (await params.secretStore.getNamespaceKeyVault(params.profile.name));
  const previousDefaultKeyPair =
    params.previousDefaultKeyPair ?? (await params.secretStore.getAgentKeyPair(params.profile.name));
  const importedAt = params.now?.() ?? new Date().toISOString();

  return withStoreLock(async () => {
    const result = markImportedRotationSnapshotPendingInStore({
      store: await readStore(),
      snapshot: params.snapshot,
      importedAt,
      isKnownCurrent: actor => {
        const previous = findPreviousCurrentKeyPair({
          profile: params.profile,
          previousVault,
          previousDefaultKeyPair,
          identity: actor.identity,
        });
        return sameAgentKeyPairPublicTuple(previous, actor.current);
      },
    });

    if (result.changed) {
      await writeStore(result.store);
    }
    return result.pendingCount;
  });
}

export async function getImportedRotationKeyConfirmationStatus(params: {
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
}): Promise<ImportedRotationKeyConfirmationStatus> {
  return getImportedRotationKeyConfirmationStatusFromStore(
    await readStore(),
    params.identity,
    params.keyPair
  );
}

export async function requireImportedRotationKeyConfirmed(params: {
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
}): Promise<void> {
  const status = await getImportedRotationKeyConfirmationStatus(params);
  if (status.status !== 'pending') {
    return;
  }

  throw userError(
    `Rotated private keys for \`${params.identity.slug}\` were imported automatically on this CLI profile. Confirm them locally before sending.`,
    {
      code: 'IMPORTED_ROTATION_KEYS_UNCONFIRMED',
      hint: `masumi-agent-messenger account keys confirm --slug ${params.identity.slug}`,
    }
  );
}

export async function confirmImportedRotationKey(params: {
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
  now?: () => string;
}): Promise<ImportedRotationKeyConfirmationStatus['status']> {
  return withStoreLock(async () => {
    const result = confirmImportedRotationKeyInStore({
      store: await readStore(),
      identity: params.identity,
      keyPair: params.keyPair,
      now: params.now?.() ?? new Date().toISOString(),
    });
    await writeStore(result.store);
    return result.previousStatus;
  });
}

function resolveRequestedSlug(profile: ResolvedProfile, actorSlug: string | undefined): string | null {
  const requested =
    actorSlug?.trim() ||
    profile.activeAgentSlug?.trim() ||
    profile.bootstrapSnapshot?.actor.slug.trim() ||
    '';
  return normalizeInboxSlug(requested);
}

function findActorBySlug(
  vault: NamespaceKeyVault | null,
  slug: string | null
): SharedActorKeyMaterial | null {
  if (!slug) {
    const actorsWithCurrent = vault?.actors.filter(actor => actor.current) ?? [];
    return actorsWithCurrent.length === 1 ? actorsWithCurrent[0] ?? null : null;
  }
  return vault?.actors.find(actor => normalizeInboxSlug(actor.identity.slug) === slug) ?? null;
}

function defaultIdentityForSlug(
  profile: ResolvedProfile,
  slug: string | null
): ActorIdentity | null {
  const snapshot = profile.bootstrapSnapshot;
  if (!snapshot) {
    return null;
  }
  const defaultSlug = normalizeInboxSlug(snapshot.actor.slug);
  if (slug && defaultSlug !== slug) {
    return null;
  }
  return {
    normalizedEmail: snapshot.inbox.normalizedEmail,
    slug: snapshot.actor.slug,
  };
}

export async function confirmCurrentImportedRotationKey(params: {
  profileName: string;
  actorSlug?: string;
  secretStore?: SecretStore;
}): Promise<ConfirmCurrentImportedRotationKeyResult> {
  const profile = await loadProfile(params.profileName);
  const secretStore = params.secretStore ?? createSecretStore();
  const vault = await secretStore.getNamespaceKeyVault(profile.name);
  const requestedSlug = resolveRequestedSlug(profile, params.actorSlug);
  const actor = findActorBySlug(vault, requestedSlug);
  const identity = actor?.identity ?? defaultIdentityForSlug(profile, requestedSlug);
  const keyPair =
    actor?.current ??
    (identity && isDefaultProfileActor(profile, identity)
      ? await secretStore.getAgentKeyPair(profile.name)
      : null);

  if (!identity || !keyPair) {
    throw userError(
      params.actorSlug
        ? `No local current private keys found for \`${params.actorSlug}\`.`
        : 'No local current private keys found to confirm.',
      {
        code: 'LOCAL_IMPORTED_ROTATION_KEYS_NOT_FOUND',
      }
    );
  }

  const previousStatus = await confirmImportedRotationKey({
    identity,
    keyPair,
  });

  return {
    profile: profile.name,
    slug: identity.slug,
    previousStatus,
  };
}
