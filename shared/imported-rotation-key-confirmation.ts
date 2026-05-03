import { normalizeKeyVersion, type ActorIdentity, type AgentKeyPair } from './agent-crypto';
import type { DeviceKeyShareSnapshot, SharedActorKeyMaterial } from './device-sharing';
import { normalizeEmail, normalizeInboxSlug } from './inbox-slug';

export const IMPORTED_ROTATION_KEY_CONFIRMATION_STORE_VERSION = 1;

export type ImportedRotationKeyConfirmationRecord = {
  email: string;
  slug: string;
  accountIdentifier?: string;
  encryptionPublicKey: string;
  encryptionKeyVersion: number;
  signingPublicKey: string;
  signingKeyVersion: number;
  importedAt: string;
  confirmedAt?: string;
};

export type ImportedRotationKeyConfirmationStore = {
  version: typeof IMPORTED_ROTATION_KEY_CONFIRMATION_STORE_VERSION;
  records: ImportedRotationKeyConfirmationRecord[];
};

export type ImportedRotationKeyConfirmationStatus =
  | {
      status: 'none';
      record: null;
    }
  | {
      status: 'pending' | 'confirmed';
      record: ImportedRotationKeyConfirmationRecord;
    };

export type MarkImportedRotationSnapshotPendingResult = {
  store: ImportedRotationKeyConfirmationStore;
  pendingCount: number;
  changed: boolean;
};

export function emptyImportedRotationKeyConfirmationStore(): ImportedRotationKeyConfirmationStore {
  return {
    version: IMPORTED_ROTATION_KEY_CONFIRMATION_STORE_VERSION,
    records: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  return value;
}

function requireStringFromAliases(
  record: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error('Imported rotation key confirmation store is corrupt.');
    }
    return value;
  }

  throw new Error('Imported rotation key confirmation store is corrupt.');
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  return value;
}

function optionalStringFromAliases(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error('Imported rotation key confirmation store is corrupt.');
    }
    return value;
  }

  return undefined;
}

function readKeyVersion(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    typeof value !== 'number' &&
    typeof value !== 'string' &&
    value !== undefined &&
    value !== null
  ) {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  return normalizeKeyVersion(value);
}

function parseRecord(value: unknown): ImportedRotationKeyConfirmationRecord {
  if (!isRecord(value)) {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  const slug = requireString(value, 'slug');

  return {
    email: normalizeEmail(requireStringFromAliases(value, ['email', 'normalizedEmail'])),
    slug: normalizeInboxSlug(slug) ?? slug,
    accountIdentifier: optionalStringFromAliases(value, [
      'accountIdentifier',
      'inboxIdentifier',
    ]),
    encryptionPublicKey: requireString(value, 'encryptionPublicKey'),
    encryptionKeyVersion: readKeyVersion(value, 'encryptionKeyVersion'),
    signingPublicKey: requireString(value, 'signingPublicKey'),
    signingKeyVersion: readKeyVersion(value, 'signingKeyVersion'),
    importedAt: requireString(value, 'importedAt'),
    confirmedAt: optionalString(value, 'confirmedAt'),
  };
}

export function parseImportedRotationKeyConfirmationStore(
  value: unknown
): ImportedRotationKeyConfirmationStore {
  if (!isRecord(value)) {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  if (value.version !== IMPORTED_ROTATION_KEY_CONFIRMATION_STORE_VERSION) {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }
  if (!Array.isArray(value.records)) {
    throw new Error('Imported rotation key confirmation store is corrupt.');
  }

  return {
    version: IMPORTED_ROTATION_KEY_CONFIRMATION_STORE_VERSION,
    records: value.records.map(parseRecord),
  };
}

export function importedRotationActorKey(identity: ActorIdentity): string {
  const emailValue = normalizeEmail(identity.email);
  const slug = normalizeInboxSlug(identity.slug) ?? identity.slug.trim();
  return `${emailValue}:${slug}`;
}

export function sameAgentKeyPairPublicTuple(
  left: AgentKeyPair | null | undefined,
  right: AgentKeyPair | null | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.encryption.publicKey === right.encryption.publicKey &&
      normalizeKeyVersion(left.encryption.keyVersion) ===
        normalizeKeyVersion(right.encryption.keyVersion) &&
      left.signing.publicKey === right.signing.publicKey &&
      normalizeKeyVersion(left.signing.keyVersion) ===
        normalizeKeyVersion(right.signing.keyVersion)
  );
}

function normalizeIdentity(identity: ActorIdentity): ActorIdentity {
  return {
    email: normalizeEmail(identity.email),
    slug: normalizeInboxSlug(identity.slug) ?? identity.slug.trim(),
    accountIdentifier: identity.accountIdentifier,
  };
}

function recordMatchesIdentity(
  record: ImportedRotationKeyConfirmationRecord,
  identity: ActorIdentity
): boolean {
  const normalized = normalizeIdentity(identity);
  return record.email === normalized.email && record.slug === normalized.slug;
}

function recordMatchesKeyPair(
  record: ImportedRotationKeyConfirmationRecord,
  keyPair: AgentKeyPair
): boolean {
  return (
    record.encryptionPublicKey === keyPair.encryption.publicKey &&
    record.encryptionKeyVersion === normalizeKeyVersion(keyPair.encryption.keyVersion) &&
    record.signingPublicKey === keyPair.signing.publicKey &&
    record.signingKeyVersion === normalizeKeyVersion(keyPair.signing.keyVersion)
  );
}

function toRecord(
  identity: ActorIdentity,
  keyPair: AgentKeyPair,
  importedAt: string
): ImportedRotationKeyConfirmationRecord {
  const normalized = normalizeIdentity(identity);
  return {
    email: normalized.email,
    slug: normalized.slug,
    accountIdentifier: normalized.accountIdentifier,
    encryptionPublicKey: keyPair.encryption.publicKey,
    encryptionKeyVersion: normalizeKeyVersion(keyPair.encryption.keyVersion),
    signingPublicKey: keyPair.signing.publicKey,
    signingKeyVersion: normalizeKeyVersion(keyPair.signing.keyVersion),
    importedAt,
  };
}

function findRecordIndex(
  store: ImportedRotationKeyConfirmationStore,
  identity: ActorIdentity,
  keyPair: AgentKeyPair
): number {
  return store.records.findIndex(
    record => recordMatchesIdentity(record, identity) && recordMatchesKeyPair(record, keyPair)
  );
}

export function getImportedRotationKeyConfirmationStatusFromStore(
  store: ImportedRotationKeyConfirmationStore,
  identity: ActorIdentity,
  keyPair: AgentKeyPair
): ImportedRotationKeyConfirmationStatus {
  const record = store.records.find(
    item => recordMatchesIdentity(item, identity) && recordMatchesKeyPair(item, keyPair)
  );
  if (!record) {
    return {
      status: 'none',
      record: null,
    };
  }

  return {
    status: record.confirmedAt ? 'confirmed' : 'pending',
    record,
  };
}

export function markImportedRotationKeyPendingInStore(params: {
  store: ImportedRotationKeyConfirmationStore;
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
  importedAt: string;
}): {
  store: ImportedRotationKeyConfirmationStore;
  changed: boolean;
  pending: boolean;
} {
  const index = findRecordIndex(params.store, params.identity, params.keyPair);
  if (index >= 0) {
    const existing = params.store.records[index];
    if (!existing || existing.confirmedAt) {
      return {
        store: params.store,
        changed: false,
        pending: false,
      };
    }
    return {
      store: params.store,
      changed: false,
      pending: true,
    };
  }

  return {
    store: {
      ...params.store,
      records: [...params.store.records, toRecord(params.identity, params.keyPair, params.importedAt)],
    },
    changed: true,
    pending: true,
  };
}

export function confirmImportedRotationKeyInStore(params: {
  store: ImportedRotationKeyConfirmationStore;
  identity: ActorIdentity;
  keyPair: AgentKeyPair;
  now: string;
}): {
  store: ImportedRotationKeyConfirmationStore;
  previousStatus: ImportedRotationKeyConfirmationStatus['status'];
} {
  const index = findRecordIndex(params.store, params.identity, params.keyPair);
  if (index < 0) {
    return {
      store: {
        ...params.store,
        records: [
          ...params.store.records,
          {
            ...toRecord(params.identity, params.keyPair, params.now),
            confirmedAt: params.now,
          },
        ],
      },
      previousStatus: 'none',
    };
  }

  const existing = params.store.records[index];
  if (!existing) {
    return {
      store: params.store,
      previousStatus: 'none',
    };
  }

  if (existing.confirmedAt) {
    return {
      store: params.store,
      previousStatus: 'confirmed',
    };
  }

  return {
    store: {
      ...params.store,
      records: params.store.records.map((record, recordIndex) =>
        recordIndex === index ? { ...record, confirmedAt: params.now } : record
      ),
    },
    previousStatus: 'pending',
  };
}

export function markImportedRotationSnapshotPendingInStore(params: {
  store: ImportedRotationKeyConfirmationStore;
  snapshot: DeviceKeyShareSnapshot;
  importedAt: string;
  isKnownCurrent?: (actor: SharedActorKeyMaterial) => boolean;
}): MarkImportedRotationSnapshotPendingResult {
  let store = params.store;
  let pendingCount = 0;
  let changed = false;

  for (const actor of params.snapshot.actors) {
    if (!actor.current) {
      continue;
    }
    if (params.isKnownCurrent?.(actor)) {
      continue;
    }

    const result = markImportedRotationKeyPendingInStore({
      store,
      identity: actor.identity,
      keyPair: actor.current,
      importedAt: params.importedAt,
    });
    store = result.store;
    changed = changed || result.changed;
    if (result.pending) {
      pendingCount += 1;
    }
  }

  return {
    store,
    pendingCount,
    changed,
  };
}
