import {
  countSharedActors,
  countSharedKeyVersions,
  parseDeviceKeyShareSnapshot,
  type DeviceKeyShareSnapshot,
} from './device-sharing';
import {
  decryptJsonWithPassphrase,
  encryptJsonWithPassphrase,
} from './passphrase-crypto';

const KEY_BACKUP_VERSION = 1;
const KEY_BACKUP_KIND = 'masumi-namespace-key-backup';
const KEY_BACKUP_ALGORITHM = 'aes-gcm-pbkdf2-namespace-backup-v1';

export type EncryptedNamespaceKeyBackupFile = {
  version: number;
  kind: string;
  normalizedEmail: string;
  createdAt: string;
  actorCount: string;
  keyVersionCount: string;
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
  algorithm: string;
};

export async function createEncryptedNamespaceKeyBackup(
  snapshot: DeviceKeyShareSnapshot,
  passphrase: string
): Promise<string> {
  const normalizedSnapshot = parseDeviceKeyShareSnapshot(snapshot);
  const encrypted = await encryptJsonWithPassphrase(
    normalizedSnapshot,
    passphrase,
    KEY_BACKUP_ALGORITHM
  );

  const file: EncryptedNamespaceKeyBackupFile = {
    version: KEY_BACKUP_VERSION,
    kind: KEY_BACKUP_KIND,
    normalizedEmail: normalizedSnapshot.normalizedEmail,
    createdAt: new Date().toISOString(),
    actorCount: countSharedActors(normalizedSnapshot).toString(),
    keyVersionCount: countSharedKeyVersions(normalizedSnapshot).toString(),
    saltHex: encrypted.saltHex,
    ivHex: encrypted.ivHex,
    ciphertextHex: encrypted.ciphertextHex,
    algorithm: encrypted.algorithm,
  };

  return JSON.stringify(file, null, 2);
}

function parseEncryptedNamespaceKeyBackupFile(
  value: unknown
): EncryptedNamespaceKeyBackupFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid encrypted namespace key backup');
  }

  const file = value as Partial<EncryptedNamespaceKeyBackupFile>;
  if (
    file.version !== KEY_BACKUP_VERSION ||
    file.kind !== KEY_BACKUP_KIND ||
    typeof file.normalizedEmail !== 'string' ||
    typeof file.createdAt !== 'string' ||
    typeof file.actorCount !== 'string' ||
    typeof file.keyVersionCount !== 'string' ||
    typeof file.saltHex !== 'string' ||
    typeof file.ivHex !== 'string' ||
    typeof file.ciphertextHex !== 'string' ||
    typeof file.algorithm !== 'string'
  ) {
    throw new Error('Invalid encrypted namespace key backup');
  }

  return file as EncryptedNamespaceKeyBackupFile;
}

export async function decryptEncryptedNamespaceKeyBackup(
  json: string,
  passphrase: string
): Promise<DeviceKeyShareSnapshot> {
  const parsed = parseEncryptedNamespaceKeyBackupFile(JSON.parse(json) as unknown);
  const snapshot = await decryptJsonWithPassphrase<DeviceKeyShareSnapshot>(
    {
      saltHex: parsed.saltHex,
      ivHex: parsed.ivHex,
      ciphertextHex: parsed.ciphertextHex,
      algorithm: parsed.algorithm,
    },
    passphrase
  );

  const normalizedSnapshot = parseDeviceKeyShareSnapshot(snapshot);
  if (normalizedSnapshot.normalizedEmail !== parsed.normalizedEmail) {
    throw new Error('Encrypted namespace key backup email does not match its manifest');
  }

  return normalizedSnapshot;
}

export function buildNamespaceKeyBackupFileName(
  normalizedEmail: string,
  createdAt = new Date()
): string {
  const safeEmail = normalizedEmail.replace(/[^a-z0-9.-]+/gi, '-');
  const dateToken = createdAt.toISOString().slice(0, 10);
  return `masumi-keys-${safeEmail}-${dateToken}.json`;
}
