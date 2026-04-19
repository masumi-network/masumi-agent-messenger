import { describe, expect, it } from 'vitest';
import {
  buildNamespaceKeyBackupFileName,
  createEncryptedNamespaceKeyBackup,
  decryptEncryptedNamespaceKeyBackup,
} from '../../../shared/key-backup';
import type { DeviceKeyShareSnapshot } from '../../../shared/device-sharing';

function createSnapshot(): DeviceKeyShareSnapshot {
  return {
    version: 1,
    normalizedEmail: 'agent@example.com',
    createdAt: '2026-04-14T12:00:00.000Z',
    actors: [
      {
        identity: {
          normalizedEmail: 'agent@example.com',
          slug: 'agent',
        },
        current: {
          encryption: {
            publicKey: 'enc-pub-current',
            privateKey: 'enc-priv-current',
            keyVersion: 'enc-v2',
            algorithm: 'ecdh-p256-v1',
          },
          signing: {
            publicKey: 'sig-pub-current',
            privateKey: 'sig-priv-current',
            keyVersion: 'sig-v2',
            algorithm: 'ecdsa-p256-sha256-v1',
          },
        },
        archived: [
          {
            encryption: {
              publicKey: 'enc-pub-archived',
              privateKey: 'enc-priv-archived',
              keyVersion: 'enc-v1',
              algorithm: 'ecdh-p256-v1',
            },
            signing: {
              publicKey: 'sig-pub-archived',
              privateKey: 'sig-priv-archived',
              keyVersion: 'sig-v1',
              algorithm: 'ecdsa-p256-sha256-v1',
            },
          },
        ],
      },
      {
        identity: {
          normalizedEmail: 'agent@example.com',
          slug: 'support-bot',
          inboxIdentifier: 'support-bot',
        },
        current: {
          encryption: {
            publicKey: 'support-enc-pub',
            privateKey: 'support-enc-priv',
            keyVersion: 'enc-v1',
            algorithm: 'ecdh-p256-v1',
          },
          signing: {
            publicKey: 'support-sig-pub',
            privateKey: 'support-sig-priv',
            keyVersion: 'sig-v1',
            algorithm: 'ecdsa-p256-sha256-v1',
          },
        },
        archived: [],
      },
    ],
  };
}

describe('encrypted namespace key backup codec', () => {
  it('round-trips a namespace snapshot including archived keys', async () => {
    const snapshot = createSnapshot();

    const encrypted = await createEncryptedNamespaceKeyBackup(snapshot, 'correct horse battery');
    const decrypted = await decryptEncryptedNamespaceKeyBackup(
      encrypted,
      'correct horse battery'
    );

    expect(decrypted).toEqual(snapshot);
  });

  it('rejects the wrong passphrase', async () => {
    const encrypted = await createEncryptedNamespaceKeyBackup(
      createSnapshot(),
      'correct horse battery'
    );

    await expect(
      decryptEncryptedNamespaceKeyBackup(encrypted, 'wrong passphrase')
    ).rejects.toThrow();
  });

  it('builds a stable backup filename from the namespace email', () => {
    expect(
      buildNamespaceKeyBackupFileName(
        'Agent+Inbox@example.com',
        new Date('2026-04-14T12:00:00.000Z')
      )
    ).toBe('masumi-keys-Agent-Inbox-example.com-2026-04-14.json');
  });
});
