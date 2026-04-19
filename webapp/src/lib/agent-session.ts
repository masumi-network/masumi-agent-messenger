import {
  actorIdentityKey,
  generateAgentKeyPair,
  nextKeyVersion,
  type ActorIdentity,
  type AgentKeyPair,
} from './crypto';
import {
  decryptJsonWithPassphrase,
  encryptJsonWithPassphrase,
  type EncryptedPassphrasePayload,
} from './passphrase-crypto';
import {
  generateDeviceKeyPair,
  type DeviceKeyPair,
  type DeviceKeyShareSnapshot,
  type SharedActorKeyMaterial,
} from '../../../shared/device-sharing';

const SESSION_SCOPE = 'masumi-agent-messenger';
const ACTIVE_ACTOR_KEY = `${SESSION_SCOPE}:active-actor-id`;
const ACTIVE_ACTOR_KEY_PREFIX = `${ACTIVE_ACTOR_KEY}:`;
const PENDING_DEVICE_SHARE_DEVICE_ID_PREFIX = `${SESSION_SCOPE}:pending-device-share-device-id:`;
const KEY_VAULT_DB_NAME = 'masumi-agent-messenger-key-vault';
const KEY_VAULT_DB_VERSION = 4;
const VAULT_META_STORE = 'vault-meta';
const ACTOR_KEYS_STORE = 'actor-keys';
const DEVICE_KEYS_STORE = 'device-keys';
const PENDING_BOOTSTRAP_KEYS_STORE = 'pending-bootstrap-keys';
const PENDING_DEVICE_SHARE_KEYS_STORE = 'pending-device-share-keys';
const VAULT_META_SCOPE = 'masumi-agent-messenger-key-vault';
const VAULT_META_ALGORITHM = 'aes-gcm-pbkdf2-vault-v1';
const ACTOR_KEYS_ALGORITHM = 'aes-gcm-pbkdf2-actor-v1';
const DEVICE_KEYS_ALGORITHM = 'aes-gcm-pbkdf2-device-v1';
const PENDING_BOOTSTRAP_KEYS_ALGORITHM = 'aes-gcm-pbkdf2-bootstrap-v1';
const PENDING_DEVICE_SHARE_KEYS_ALGORITHM = 'aes-gcm-pbkdf2-device-share-request-v1';

type VaultStatus = {
  initialized: boolean;
  unlocked: boolean;
};

type VaultMetaRecord = {
  id: string;
  version: number;
  updatedAt: string;
} & EncryptedPassphrasePayload;

type VaultMetaPayload = {
  scope: string;
  createdAt: string;
  ownerUserId?: string;
};

export type KeyVaultOwner = {
  userId: string;
  normalizedEmail: string;
};

type ActorKeyMaterial = {
  current: AgentKeyPair | null;
  archived: AgentKeyPair[];
};

export type DeviceKeyMaterial = {
  deviceId: string;
  keyPair: DeviceKeyPair;
};

export type AgentKeyRotationPlan = {
  rotated: AgentKeyPair;
  nextSharedMaterial: SharedActorKeyMaterial;
};

type ActorKeyVaultRecord = {
  id: string;
  identity: ActorIdentity;
  ownerUserId?: string;
  version: number;
  updatedAt: string;
} & EncryptedPassphrasePayload;

type DeviceKeyVaultRecord = {
  id: string;
  normalizedEmail: string;
  ownerUserId?: string;
  version: number;
  updatedAt: string;
} & EncryptedPassphrasePayload;

type PendingBootstrapKeyRecord = {
  id: string;
  normalizedEmail: string;
  ownerUserId?: string;
  version: number;
  updatedAt: string;
} & EncryptedPassphrasePayload;

type PendingDeviceShareKeyRecord = {
  id: string;
  normalizedEmail: string;
  ownerUserId?: string;
  version: number;
  updatedAt: string;
} & EncryptedPassphrasePayload;

const unlockedActorMaterial = new Map<string, ActorKeyMaterial>();
const unlockedDeviceMaterial = new Map<string, DeviceKeyMaterial>();
const unlockedPendingBootstrapMaterial = new Map<string, AgentKeyPair>();
const unlockedPendingDeviceShareMaterial = new Map<string, DeviceKeyMaterial>();
let unlockedPassphrase: string | null = null;
let unlockedVaultUserId: string | null = null;

function ensureWindow(): Window {
  if (typeof window === 'undefined') {
    throw new Error('Browser storage is unavailable in this runtime');
  }
  return window;
}

function ensureLocalStorage(): Storage {
  const browserWindow = ensureWindow();
  if (typeof browserWindow.localStorage === 'undefined') {
    throw new Error('localStorage is unavailable in this runtime');
  }
  return browserWindow.localStorage;
}

function ensureIndexedDb(): IDBFactory {
  const browserWindow = ensureWindow();
  if (typeof browserWindow.indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable in this runtime');
  }
  return browserWindow.indexedDB;
}

function cacheKey(identity: ActorIdentity): string {
  return actorIdentityKey(identity);
}

function activeActorStorageKey(normalizedEmail: string): string {
  return `${ACTIVE_ACTOR_KEY_PREFIX}${normalizedEmail.trim().toLowerCase()}`;
}

function deviceCacheKey(normalizedEmail: string): string {
  return normalizedEmail.trim().toLowerCase();
}

function pendingBootstrapCacheKey(normalizedEmail: string): string {
  return normalizedEmail.trim().toLowerCase();
}

function pendingDeviceShareCacheKey(normalizedEmail: string): string {
  return normalizedEmail.trim().toLowerCase();
}

function pendingDeviceShareDeviceIdStorageKey(normalizedEmail: string): string {
  return `${PENDING_DEVICE_SHARE_DEVICE_ID_PREFIX}${normalizedEmail.trim().toLowerCase()}`;
}

function normalizeVaultUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Masumi user id is required for the local key vault.');
  }
  return normalized;
}

function vaultMetaRecordId(owner: KeyVaultOwner): string {
  return `user:${normalizeVaultUserId(owner.userId)}`;
}

function cloneMaterial(material: ActorKeyMaterial): ActorKeyMaterial {
  return {
    current: material.current ? structuredClone(material.current) : null,
    archived: material.archived.map(pair => structuredClone(pair)),
  };
}

function cloneDeviceMaterial(material: DeviceKeyMaterial): DeviceKeyMaterial {
  return {
    deviceId: material.deviceId,
    keyPair: structuredClone(material.keyPair),
  };
}

function cloneAgentKeyPair(keyPair: AgentKeyPair): AgentKeyPair {
  return structuredClone(keyPair);
}

function getCachedMaterial(identity: ActorIdentity): ActorKeyMaterial | null {
  const cached = unlockedActorMaterial.get(cacheKey(identity));
  return cached ? cloneMaterial(cached) : null;
}

function getCachedDeviceMaterial(normalizedEmail: string): DeviceKeyMaterial | null {
  const cached = unlockedDeviceMaterial.get(deviceCacheKey(normalizedEmail));
  return cached ? cloneDeviceMaterial(cached) : null;
}

function getCachedPendingBootstrapKeyPair(normalizedEmail: string): AgentKeyPair | null {
  const cached = unlockedPendingBootstrapMaterial.get(
    pendingBootstrapCacheKey(normalizedEmail)
  );
  return cached ? cloneAgentKeyPair(cached) : null;
}

function getCachedPendingDeviceShareMaterial(normalizedEmail: string): DeviceKeyMaterial | null {
  const cached = unlockedPendingDeviceShareMaterial.get(
    pendingDeviceShareCacheKey(normalizedEmail)
  );
  return cached ? cloneDeviceMaterial(cached) : null;
}

function setCachedMaterial(identity: ActorIdentity, material: ActorKeyMaterial): void {
  unlockedActorMaterial.set(cacheKey(identity), cloneMaterial(material));
}

function setCachedDeviceMaterial(normalizedEmail: string, material: DeviceKeyMaterial): void {
  unlockedDeviceMaterial.set(deviceCacheKey(normalizedEmail), cloneDeviceMaterial(material));
}

function setCachedPendingBootstrapKeyPair(
  normalizedEmail: string,
  keyPair: AgentKeyPair
): void {
  unlockedPendingBootstrapMaterial.set(
    pendingBootstrapCacheKey(normalizedEmail),
    cloneAgentKeyPair(keyPair)
  );
}

function setCachedPendingDeviceShareMaterial(
  normalizedEmail: string,
  material: DeviceKeyMaterial
): void {
  unlockedPendingDeviceShareMaterial.set(
    pendingDeviceShareCacheKey(normalizedEmail),
    cloneDeviceMaterial(material)
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

async function withTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T>
): Promise<T> {
  const indexedDb = ensureIndexedDb();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(KEY_VAULT_DB_NAME, KEY_VAULT_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VAULT_META_STORE)) {
        database.createObjectStore(VAULT_META_STORE, {
          keyPath: 'id',
        });
      }
      if (!database.objectStoreNames.contains(ACTOR_KEYS_STORE)) {
        database.createObjectStore(ACTOR_KEYS_STORE, {
          keyPath: 'id',
        });
      }
      if (!database.objectStoreNames.contains(DEVICE_KEYS_STORE)) {
        database.createObjectStore(DEVICE_KEYS_STORE, {
          keyPath: 'id',
        });
      }
      if (!database.objectStoreNames.contains(PENDING_BOOTSTRAP_KEYS_STORE)) {
        database.createObjectStore(PENDING_BOOTSTRAP_KEYS_STORE, {
          keyPath: 'id',
        });
      }
      if (!database.objectStoreNames.contains(PENDING_DEVICE_SHARE_KEYS_STORE)) {
        database.createObjectStore(PENDING_DEVICE_SHARE_KEYS_STORE, {
          keyPath: 'id',
        });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to open IndexedDB'));
    };
  });

  try {
    const transaction = db.transaction(storeNames, mode);
    const result = await run(transaction);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
    return result;
  } finally {
    db.close();
  }
}

async function getVaultMetaRecordById(recordId: string): Promise<VaultMetaRecord | null> {
  return withTransaction(VAULT_META_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(VAULT_META_STORE);
    const result = await requestToPromise(store.get(recordId));
    return (result as VaultMetaRecord | undefined) ?? null;
  });
}

async function setVaultMetaRecord(record: VaultMetaRecord): Promise<void> {
  await withTransaction(VAULT_META_STORE, 'readwrite', async transaction => {
    transaction.objectStore(VAULT_META_STORE).put(record);
  });
}

async function getActorVaultRecord(identity: ActorIdentity): Promise<ActorKeyVaultRecord | null> {
  return withTransaction(ACTOR_KEYS_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(ACTOR_KEYS_STORE);
    const result = await requestToPromise(store.get(cacheKey(identity)));
    return (result as ActorKeyVaultRecord | undefined) ?? null;
  });
}

async function setActorVaultRecord(record: ActorKeyVaultRecord): Promise<void> {
  await withTransaction(ACTOR_KEYS_STORE, 'readwrite', async transaction => {
    transaction.objectStore(ACTOR_KEYS_STORE).put(record);
  });
}

async function getAllActorVaultRecords(): Promise<ActorKeyVaultRecord[]> {
  return withTransaction(ACTOR_KEYS_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(ACTOR_KEYS_STORE);
    const result = await requestToPromise(store.getAll());
    return (result as ActorKeyVaultRecord[] | undefined) ?? [];
  });
}

async function getDeviceVaultRecord(normalizedEmail: string): Promise<DeviceKeyVaultRecord | null> {
  return withTransaction(DEVICE_KEYS_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(DEVICE_KEYS_STORE);
    const result = await requestToPromise(store.get(deviceCacheKey(normalizedEmail)));
    return (result as DeviceKeyVaultRecord | undefined) ?? null;
  });
}

async function setDeviceVaultRecord(record: DeviceKeyVaultRecord): Promise<void> {
  await withTransaction(DEVICE_KEYS_STORE, 'readwrite', async transaction => {
    transaction.objectStore(DEVICE_KEYS_STORE).put(record);
  });
}

async function getPendingBootstrapKeyRecord(
  normalizedEmail: string
): Promise<PendingBootstrapKeyRecord | null> {
  return withTransaction(PENDING_BOOTSTRAP_KEYS_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(PENDING_BOOTSTRAP_KEYS_STORE);
    const result = await requestToPromise(
      store.get(pendingBootstrapCacheKey(normalizedEmail))
    );
    return (result as PendingBootstrapKeyRecord | undefined) ?? null;
  });
}

async function setPendingBootstrapKeyRecord(
  record: PendingBootstrapKeyRecord
): Promise<void> {
  await withTransaction(PENDING_BOOTSTRAP_KEYS_STORE, 'readwrite', async transaction => {
    transaction.objectStore(PENDING_BOOTSTRAP_KEYS_STORE).put(record);
  });
}

async function getPendingDeviceShareKeyRecord(
  normalizedEmail: string
): Promise<PendingDeviceShareKeyRecord | null> {
  return withTransaction(PENDING_DEVICE_SHARE_KEYS_STORE, 'readonly', async transaction => {
    const store = transaction.objectStore(PENDING_DEVICE_SHARE_KEYS_STORE);
    const result = await requestToPromise(
      store.get(pendingDeviceShareCacheKey(normalizedEmail))
    );
    return (result as PendingDeviceShareKeyRecord | undefined) ?? null;
  });
}

async function setPendingDeviceShareKeyRecord(
  record: PendingDeviceShareKeyRecord
): Promise<void> {
  await withTransaction(PENDING_DEVICE_SHARE_KEYS_STORE, 'readwrite', async transaction => {
    transaction.objectStore(PENDING_DEVICE_SHARE_KEYS_STORE).put(record);
  });
}

async function deletePendingDeviceShareKeyRecord(normalizedEmail: string): Promise<void> {
  await withTransaction(PENDING_DEVICE_SHARE_KEYS_STORE, 'readwrite', async transaction => {
    transaction
      .objectStore(PENDING_DEVICE_SHARE_KEYS_STORE)
      .delete(pendingDeviceShareCacheKey(normalizedEmail));
  });
}

async function deletePendingBootstrapKeyRecord(normalizedEmail: string): Promise<void> {
  await withTransaction(PENDING_BOOTSTRAP_KEYS_STORE, 'readwrite', async transaction => {
    transaction
      .objectStore(PENDING_BOOTSTRAP_KEYS_STORE)
      .delete(pendingBootstrapCacheKey(normalizedEmail));
  });
}

async function getVaultMetaRecordForOwner(owner: KeyVaultOwner): Promise<VaultMetaRecord | null> {
  return getVaultMetaRecordById(vaultMetaRecordId(owner));
}

function requireUnlockedPassphrase(): string {
  if (!unlockedPassphrase || !unlockedVaultUserId) {
    throw new Error('Private keys are locked. Unlock the local key vault first.');
  }
  return unlockedPassphrase;
}

function requireUnlockedVaultUserId(): string {
  if (!unlockedVaultUserId) {
    throw new Error('Private keys are locked. Unlock the local key vault first.');
  }
  return unlockedVaultUserId;
}

async function persistMaterial(
  identity: ActorIdentity,
  material: ActorKeyMaterial,
  passphrase: string
): Promise<void> {
  const encrypted = await encryptJsonWithPassphrase(
    material,
    passphrase,
    ACTOR_KEYS_ALGORITHM
  );

  await setActorVaultRecord({
    id: cacheKey(identity),
    identity,
    ownerUserId: requireUnlockedVaultUserId(),
    version: 1,
    updatedAt: new Date().toISOString(),
    ...encrypted,
  });
  setCachedMaterial(identity, material);
}

async function loadMaterialFromRecord(
  identity: ActorIdentity,
  record: ActorKeyVaultRecord,
  passphrase: string
): Promise<ActorKeyMaterial> {
  const decrypted = await decryptJsonWithPassphrase<ActorKeyMaterial>(
    {
      saltHex: record.saltHex,
      ivHex: record.ivHex,
      ciphertextHex: record.ciphertextHex,
      algorithm: record.algorithm,
    },
    passphrase
  );
  setCachedMaterial(identity, decrypted);
  return cloneMaterial(decrypted);
}

async function persistDeviceMaterial(
  normalizedEmail: string,
  material: DeviceKeyMaterial,
  passphrase: string
): Promise<void> {
  const encrypted = await encryptJsonWithPassphrase(
    material,
    passphrase,
    DEVICE_KEYS_ALGORITHM
  );

  await setDeviceVaultRecord({
    id: deviceCacheKey(normalizedEmail),
    normalizedEmail,
    ownerUserId: requireUnlockedVaultUserId(),
    version: 1,
    updatedAt: new Date().toISOString(),
    ...encrypted,
  });
  setCachedDeviceMaterial(normalizedEmail, material);
}

async function loadDeviceMaterialFromRecord(
  normalizedEmail: string,
  record: DeviceKeyVaultRecord,
  passphrase: string
): Promise<DeviceKeyMaterial> {
  const decrypted = await decryptJsonWithPassphrase<DeviceKeyMaterial>(
    {
      saltHex: record.saltHex,
      ivHex: record.ivHex,
      ciphertextHex: record.ciphertextHex,
      algorithm: record.algorithm,
    },
    passphrase
  );
  setCachedDeviceMaterial(normalizedEmail, decrypted);
  return cloneDeviceMaterial(decrypted);
}

async function persistPendingDeviceShareMaterial(
  normalizedEmail: string,
  material: DeviceKeyMaterial,
  passphrase: string
): Promise<void> {
  const encrypted = await encryptJsonWithPassphrase(
    material,
    passphrase,
    PENDING_DEVICE_SHARE_KEYS_ALGORITHM
  );

  await setPendingDeviceShareKeyRecord({
    id: pendingDeviceShareCacheKey(normalizedEmail),
    normalizedEmail,
    ownerUserId: requireUnlockedVaultUserId(),
    version: 1,
    updatedAt: new Date().toISOString(),
    ...encrypted,
  });
  setCachedPendingDeviceShareMaterial(normalizedEmail, material);
}

async function loadPendingDeviceShareMaterialFromRecord(
  normalizedEmail: string,
  record: PendingDeviceShareKeyRecord,
  passphrase: string
): Promise<DeviceKeyMaterial> {
  const decrypted = await decryptJsonWithPassphrase<DeviceKeyMaterial>(
    {
      saltHex: record.saltHex,
      ivHex: record.ivHex,
      ciphertextHex: record.ciphertextHex,
      algorithm: record.algorithm,
    },
    passphrase
  );
  setCachedPendingDeviceShareMaterial(normalizedEmail, decrypted);
  return cloneDeviceMaterial(decrypted);
}

export async function getKeyVaultStatus(owner: KeyVaultOwner): Promise<VaultStatus> {
  const meta = await getVaultMetaRecordForOwner(owner);
  return {
    initialized: Boolean(meta),
    unlocked: Boolean(meta && unlockedPassphrase && unlockedVaultUserId === normalizeVaultUserId(owner.userId)),
  };
}

export async function initializeKeyVault(owner: KeyVaultOwner, passphrase: string): Promise<void> {
  const existing = await getVaultMetaRecordForOwner(owner);
  if (existing) {
    throw new Error('Local key vault already exists. Unlock it with your passphrase.');
  }

  const encrypted = await encryptJsonWithPassphrase(
    {
      scope: VAULT_META_SCOPE,
      createdAt: new Date().toISOString(),
      ownerUserId: normalizeVaultUserId(owner.userId),
    },
    passphrase,
    VAULT_META_ALGORITHM
  );

  await setVaultMetaRecord({
    id: vaultMetaRecordId(owner),
    version: 1,
    updatedAt: new Date().toISOString(),
    ...encrypted,
  });
  unlockedPassphrase = passphrase;
  unlockedVaultUserId = normalizeVaultUserId(owner.userId);
}

export async function unlockKeyVault(owner: KeyVaultOwner, passphrase: string): Promise<void> {
  const meta = await getVaultMetaRecordForOwner(owner);
  if (!meta) {
    throw new Error('Local key vault is not initialized yet.');
  }

  const payload = await decryptJsonWithPassphrase<VaultMetaPayload>(
    {
      saltHex: meta.saltHex,
      ivHex: meta.ivHex,
      ciphertextHex: meta.ciphertextHex,
      algorithm: meta.algorithm,
    },
    passphrase
  );

  const normalizedOwnerUserId = normalizeVaultUserId(owner.userId);
  if (
    payload.scope !== VAULT_META_SCOPE ||
    (payload.ownerUserId && payload.ownerUserId !== normalizedOwnerUserId)
  ) {
    throw new Error('Invalid local key vault payload.');
  }

  unlockedPassphrase = passphrase;
  unlockedVaultUserId = normalizedOwnerUserId;

  if (meta.id !== vaultMetaRecordId(owner)) {
    const encrypted = await encryptJsonWithPassphrase(
      {
        scope: VAULT_META_SCOPE,
        createdAt: payload.createdAt,
        ownerUserId: normalizedOwnerUserId,
      },
      passphrase,
      VAULT_META_ALGORITHM
    );

    await setVaultMetaRecord({
      id: vaultMetaRecordId(owner),
      version: 1,
      updatedAt: new Date().toISOString(),
      ...encrypted,
    });
  }
}

export function clearUnlockedKeySession(): void {
  unlockedPassphrase = null;
  unlockedVaultUserId = null;
  unlockedActorMaterial.clear();
  unlockedDeviceMaterial.clear();
  unlockedPendingBootstrapMaterial.clear();
  unlockedPendingDeviceShareMaterial.clear();
}

export function getArchivedAgentKeyPairs(identity: ActorIdentity): AgentKeyPair[] {
  return getCachedMaterial(identity)?.archived ?? [];
}

function parseStoredActorIdentity(raw: string | null): ActorIdentity | null {
  if (!raw) return null;

  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'normalizedEmail' in parsed &&
    'slug' in parsed &&
    typeof parsed.normalizedEmail === 'string' &&
    typeof parsed.slug === 'string'
  ) {
    return {
      normalizedEmail: parsed.normalizedEmail,
      slug: parsed.slug,
      inboxIdentifier:
        'inboxIdentifier' in parsed && typeof parsed.inboxIdentifier === 'string'
          ? parsed.inboxIdentifier
          : undefined,
    };
  }

  return null;
}

export function getAgentKeyPairForEncryptionVersion(
  identity: ActorIdentity,
  encryptionKeyVersion: string
): AgentKeyPair | null {
  const current = getStoredAgentKeyPair(identity);
  if (current && current.encryption.keyVersion === encryptionKeyVersion) {
    return current;
  }

  const archived = getArchivedAgentKeyPairs(identity);
  return archived.find(pair => pair.encryption.keyVersion === encryptionKeyVersion) ?? null;
}

export function getActiveActorIdentity(normalizedEmail?: string): ActorIdentity | null {
  try {
    const storage = ensureLocalStorage();
    if (normalizedEmail) {
      const normalizedKey = activeActorStorageKey(normalizedEmail);
      const namespaced = parseStoredActorIdentity(storage.getItem(normalizedKey));
      if (namespaced) {
        return namespaced;
      }

      const fallback = parseStoredActorIdentity(storage.getItem(ACTIVE_ACTOR_KEY));
      if (fallback?.normalizedEmail === normalizedEmail) {
        const serialized = JSON.stringify(fallback);
        storage.setItem(normalizedKey, serialized);
        return fallback;
      }

      return null;
    }

    return parseStoredActorIdentity(storage.getItem(ACTIVE_ACTOR_KEY));
  } catch {
    return null;
  }
}

export function setActiveActorIdentity(identity: ActorIdentity): void {
  const storage = ensureLocalStorage();
  const serialized = JSON.stringify(identity);
  storage.setItem(ACTIVE_ACTOR_KEY, serialized);
  storage.setItem(activeActorStorageKey(identity.normalizedEmail), serialized);
}

export function getStoredAgentKeyPair(identity: ActorIdentity): AgentKeyPair | null {
  return getCachedMaterial(identity)?.current ?? null;
}

export async function loadStoredAgentKeyPair(identity: ActorIdentity): Promise<AgentKeyPair | null> {
  const cached = getStoredAgentKeyPair(identity);
  if (cached) {
    return cached;
  }

  const record = await getActorVaultRecord(identity);
  if (!record) {
    return null;
  }

  const material = await loadMaterialFromRecord(identity, record, requireUnlockedPassphrase());
  return material.current;
}

export async function setStoredAgentKeyPair(
  identity: ActorIdentity,
  keyPair: AgentKeyPair
): Promise<void> {
  const passphrase = requireUnlockedPassphrase();
  const current = await loadStoredAgentKeyPair(identity);
  const archived = getArchivedAgentKeyPairs(identity);
  await persistMaterial(
    identity,
    {
      current: keyPair,
      archived:
        current && current.encryption.keyVersion !== keyPair.encryption.keyVersion
          ? [...archived, current]
          : archived,
    },
    passphrase
  );
}

export async function loadStoredDeviceKeyMaterial(
  normalizedEmail: string
): Promise<DeviceKeyMaterial | null> {
  const cached = getCachedDeviceMaterial(normalizedEmail);
  if (cached) {
    return cached;
  }

  const record = await getDeviceVaultRecord(normalizedEmail);
  if (!record) {
    return null;
  }

  return loadDeviceMaterialFromRecord(normalizedEmail, record, requireUnlockedPassphrase());
}

export async function loadPendingDeviceShareKeyMaterial(
  normalizedEmail: string
): Promise<DeviceKeyMaterial | null> {
  const cached = getCachedPendingDeviceShareMaterial(normalizedEmail);
  if (cached) {
    return cached;
  }

  const record = await getPendingDeviceShareKeyRecord(normalizedEmail);
  if (!record) {
    return null;
  }

  return loadPendingDeviceShareMaterialFromRecord(
    normalizedEmail,
    record,
    requireUnlockedPassphrase()
  );
}

function getOrCreatePendingDeviceShareDeviceId(normalizedEmail: string): string {
  const storage = ensureLocalStorage();
  const storageKey = pendingDeviceShareDeviceIdStorageKey(normalizedEmail);
  const existing = storage.getItem(storageKey)?.trim();
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  storage.setItem(storageKey, created);
  return created;
}

export async function createPendingDeviceShareKeyMaterial(
  normalizedEmail: string
): Promise<DeviceKeyMaterial> {
  const created: DeviceKeyMaterial = {
    deviceId: getOrCreatePendingDeviceShareDeviceId(normalizedEmail),
    keyPair: await generateDeviceKeyPair(),
  };
  await persistPendingDeviceShareMaterial(normalizedEmail, created, requireUnlockedPassphrase());
  return created;
}

export async function clearPendingDeviceShareKeyMaterial(
  normalizedEmail: string
): Promise<void> {
  await deletePendingDeviceShareKeyRecord(normalizedEmail);
  unlockedPendingDeviceShareMaterial.delete(pendingDeviceShareCacheKey(normalizedEmail));
}

export async function getOrCreateDeviceKeyMaterial(
  normalizedEmail: string
): Promise<DeviceKeyMaterial> {
  const existing = await loadStoredDeviceKeyMaterial(normalizedEmail);
  if (existing) {
    return existing;
  }

  const created: DeviceKeyMaterial = {
    deviceId: crypto.randomUUID(),
    keyPair: await generateDeviceKeyPair(),
  };
  await persistDeviceMaterial(normalizedEmail, created, requireUnlockedPassphrase());
  return created;
}

export async function hasPendingBootstrapKeyPair(owner: KeyVaultOwner): Promise<boolean> {
  const record = await getPendingBootstrapKeyRecord(owner.normalizedEmail);
  if (!record) {
    return false;
  }

  return record.ownerUserId
    ? record.ownerUserId === normalizeVaultUserId(owner.userId)
    : true;
}

export async function loadPendingBootstrapKeyPair(
  normalizedEmail: string
): Promise<AgentKeyPair | null> {
  const cached = getCachedPendingBootstrapKeyPair(normalizedEmail);
  if (cached) {
    return cached;
  }

  const record = await getPendingBootstrapKeyRecord(normalizedEmail);
  if (!record) {
    return null;
  }

  const keyPair = await decryptJsonWithPassphrase<AgentKeyPair>(
    {
      saltHex: record.saltHex,
      ivHex: record.ivHex,
      ciphertextHex: record.ciphertextHex,
      algorithm: record.algorithm,
    },
    requireUnlockedPassphrase()
  );
  setCachedPendingBootstrapKeyPair(normalizedEmail, keyPair);
  return cloneAgentKeyPair(keyPair);
}

export async function setPendingBootstrapKeyPair(
  normalizedEmail: string,
  keyPair: AgentKeyPair
): Promise<void> {
  const encrypted = await encryptJsonWithPassphrase(
    keyPair,
    requireUnlockedPassphrase(),
    PENDING_BOOTSTRAP_KEYS_ALGORITHM
  );

  await setPendingBootstrapKeyRecord({
    id: pendingBootstrapCacheKey(normalizedEmail),
    normalizedEmail,
    ownerUserId: requireUnlockedVaultUserId(),
    version: 1,
    updatedAt: new Date().toISOString(),
    ...encrypted,
  });
  setCachedPendingBootstrapKeyPair(normalizedEmail, keyPair);
}

export async function clearPendingBootstrapKeyPair(
  normalizedEmail: string
): Promise<void> {
  await deletePendingBootstrapKeyRecord(normalizedEmail);
  unlockedPendingBootstrapMaterial.delete(pendingBootstrapCacheKey(normalizedEmail));
}

export async function getOrCreatePendingBootstrapKeyPair(
  normalizedEmail: string
): Promise<AgentKeyPair> {
  const existing = await loadPendingBootstrapKeyPair(normalizedEmail);
  if (existing) {
    return existing;
  }

  const created = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  await setPendingBootstrapKeyPair(normalizedEmail, created);
  return created;
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

function mergeSharedActorMaterial(
  existing: ActorKeyMaterial | null,
  imported: SharedActorKeyMaterial
): ActorKeyMaterial {
  const archived = dedupeArchivedKeyPairs([
    ...(existing?.archived ?? []),
    ...imported.archived,
    ...(existing?.current && imported.current
      ? [existing.current]
      : []),
  ]).filter(pair => {
    return pair.encryption.keyVersion !== imported.current?.encryption.keyVersion;
  });

  return {
    current: imported.current,
    archived,
  };
}

export async function exportInboxKeyShareSnapshot(
  normalizedEmail: string,
  options?: {
    overrides?: SharedActorKeyMaterial[];
  }
): Promise<DeviceKeyShareSnapshot> {
  const passphrase = requireUnlockedPassphrase();
  const ownerUserId = requireUnlockedVaultUserId();
  const records = await getAllActorVaultRecords();
  const actors: SharedActorKeyMaterial[] = [];
  const overrideByIdentityKey = new Map(
    (options?.overrides ?? []).map(override => [cacheKey(override.identity), override] as const)
  );

  for (const record of records) {
    if (record.ownerUserId && record.ownerUserId !== ownerUserId) {
      continue;
    }
    if (record.identity.normalizedEmail !== normalizedEmail) {
      continue;
    }

    const override = overrideByIdentityKey.get(cacheKey(record.identity));
    if (override) {
      actors.push({
        identity: override.identity,
        current: override.current ? structuredClone(override.current) : null,
        archived: override.archived.map(pair => structuredClone(pair)),
      });
      overrideByIdentityKey.delete(cacheKey(record.identity));
      continue;
    }

    const material = await loadMaterialFromRecord(record.identity, record, passphrase);
    actors.push({
      identity: record.identity,
      current: material.current,
      archived: material.archived,
    });
  }

  for (const override of overrideByIdentityKey.values()) {
    if (override.identity.normalizedEmail !== normalizedEmail) {
      continue;
    }

    actors.push({
      identity: override.identity,
      current: override.current ? structuredClone(override.current) : null,
      archived: override.archived.map(pair => structuredClone(pair)),
    });
  }

  return {
    version: 1,
    normalizedEmail,
    createdAt: new Date().toISOString(),
    actors,
  };
}

export async function importInboxKeyShareSnapshot(
  snapshot: DeviceKeyShareSnapshot
): Promise<void> {
  const passphrase = requireUnlockedPassphrase();

  for (const actor of snapshot.actors) {
    const existing = await loadStoredAgentKeyPair(actor.identity);
    const merged = mergeSharedActorMaterial(
      existing
        ? {
            current: existing,
            archived: getArchivedAgentKeyPairs(actor.identity),
          }
        : null,
      actor
    );

    await persistMaterial(actor.identity, merged, passphrase);
  }
}

export async function getOrCreateAgentKeyPair(
  identity: ActorIdentity
): Promise<AgentKeyPair> {
  const existing = await loadStoredAgentKeyPair(identity);
  if (existing) {
    return existing;
  }

  const created = await generateAgentKeyPair({
    encryptionKeyVersion: 'enc-v1',
    signingKeyVersion: 'sig-v1',
  });
  await persistMaterial(
    identity,
    {
      current: created,
      archived: getArchivedAgentKeyPairs(identity),
    },
    requireUnlockedPassphrase()
  );
  return created;
}

export async function previewStoredAgentKeyRotation(
  identity: ActorIdentity,
  publishedCurrent?: {
    encryptionPublicKey: string;
    encryptionKeyVersion: string;
    signingPublicKey: string;
    signingKeyVersion: string;
  }
): Promise<AgentKeyRotationPlan> {
  const current = await loadStoredAgentKeyPair(identity);
  const currentEncryptionKeyVersion =
    publishedCurrent?.encryptionKeyVersion ?? current?.encryption.keyVersion;
  const currentSigningKeyVersion =
    publishedCurrent?.signingKeyVersion ?? current?.signing.keyVersion;
  const rotated = await generateAgentKeyPair({
    encryptionKeyVersion: nextKeyVersion(currentEncryptionKeyVersion, 'enc-v'),
    signingKeyVersion: nextKeyVersion(currentSigningKeyVersion, 'sig-v'),
  });

  const archived = getArchivedAgentKeyPairs(identity);
  if (
    current &&
    (!publishedCurrent ||
      (current.encryption.publicKey === publishedCurrent.encryptionPublicKey &&
        current.encryption.keyVersion === publishedCurrent.encryptionKeyVersion &&
        current.signing.publicKey === publishedCurrent.signingPublicKey &&
        current.signing.keyVersion === publishedCurrent.signingKeyVersion)) &&
    !archived.some(pair => pair.encryption.keyVersion === current.encryption.keyVersion)
  ) {
    archived.push(current);
  }

  return {
    rotated,
    nextSharedMaterial: {
      identity,
      current: rotated,
      archived,
    },
  };
}

export async function commitStoredAgentKeyRotation(
  plan: AgentKeyRotationPlan
): Promise<void> {
  await persistMaterial(
    plan.nextSharedMaterial.identity,
    {
      current: plan.nextSharedMaterial.current,
      archived: plan.nextSharedMaterial.archived,
    },
    requireUnlockedPassphrase()
  );
}

export async function rotateStoredAgentKeyPair(
  identity: ActorIdentity,
  publishedCurrent?: {
    encryptionPublicKey: string;
    encryptionKeyVersion: string;
    signingPublicKey: string;
    signingKeyVersion: string;
  }
): Promise<AgentKeyPair> {
  const plan = await previewStoredAgentKeyRotation(identity, publishedCurrent);
  await commitStoredAgentKeyRotation(plan);
  return plan.rotated;
}
