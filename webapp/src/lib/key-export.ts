import {
  buildNamespaceKeyBackupFileName,
  createEncryptedNamespaceKeyBackup,
  decryptEncryptedNamespaceKeyBackup,
  type EncryptedNamespaceKeyBackupFile,
} from '../../../shared/key-backup';
import {
  exportInboxKeyShareSnapshot,
  importInboxKeyShareSnapshot,
} from './agent-session';

export type { EncryptedNamespaceKeyBackupFile };

export async function createEncryptedNamespaceKeyBackupForAccount(
  email: string,
  passphrase: string
): Promise<{ fileName: string; json: string }> {
  const snapshot = await exportInboxKeyShareSnapshot(email);
  return {
    fileName: buildNamespaceKeyBackupFileName(email),
    json: await createEncryptedNamespaceKeyBackup(snapshot, passphrase),
  };
}

export async function importEncryptedNamespaceKeyBackupForAccount(
  json: string,
  passphrase: string,
  expectedNormalizedEmail: string
): Promise<void> {
  const snapshot = await decryptEncryptedNamespaceKeyBackup(json, passphrase);
  if (snapshot.email !== expectedNormalizedEmail) {
    throw new Error('This backup belongs to a different account email namespace.');
  }

  await importInboxKeyShareSnapshot(snapshot);
}
