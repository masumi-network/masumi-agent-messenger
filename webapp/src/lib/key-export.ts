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

export async function createEncryptedNamespaceKeyBackupForInbox(
  normalizedEmail: string,
  passphrase: string
): Promise<{ fileName: string; json: string }> {
  const snapshot = await exportInboxKeyShareSnapshot(normalizedEmail);
  return {
    fileName: buildNamespaceKeyBackupFileName(normalizedEmail),
    json: await createEncryptedNamespaceKeyBackup(snapshot, passphrase),
  };
}

export async function importEncryptedNamespaceKeyBackupForInbox(
  json: string,
  passphrase: string,
  expectedNormalizedEmail: string
): Promise<void> {
  const snapshot = await decryptEncryptedNamespaceKeyBackup(json, passphrase);
  if (snapshot.normalizedEmail !== expectedNormalizedEmail) {
    throw new Error('This backup belongs to a different inbox email namespace.');
  }

  await importInboxKeyShareSnapshot(snapshot);
}
