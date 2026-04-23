import { describe, expect, it } from 'vitest';
import {
  buildNamespaceKeyBackupFileName,
  createEncryptedNamespaceKeyBackup,
  decryptEncryptedNamespaceKeyBackup,
} from '../../../shared/key-backup';
import type { DeviceKeyShareSnapshot } from '../../../shared/device-sharing';

function publicKey(label: string): string {
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: `x-${label}`, y: `y-${label}` });
}

function privateKey(label: string): string {
  return JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: `x-${label}`,
    y: `y-${label}`,
    d: `d-${label}`,
  });
}

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
            publicKey: publicKey('enc-current'),
            privateKey: privateKey('enc-current'),
            keyVersion: 'enc-v2',
            algorithm: 'ecdh-p256-v1',
          },
          signing: {
            publicKey: publicKey('sig-current'),
            privateKey: privateKey('sig-current'),
            keyVersion: 'sig-v2',
            algorithm: 'ecdsa-p256-sha256-v1',
          },
        },
        archived: [
          {
            encryption: {
              publicKey: publicKey('enc-archived'),
              privateKey: privateKey('enc-archived'),
              keyVersion: 'enc-v1',
              algorithm: 'ecdh-p256-v1',
            },
            signing: {
              publicKey: publicKey('sig-archived'),
              privateKey: privateKey('sig-archived'),
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
            publicKey: publicKey('support-enc'),
            privateKey: privateKey('support-enc'),
            keyVersion: 'enc-v1',
            algorithm: 'ecdh-p256-v1',
          },
          signing: {
            publicKey: publicKey('support-sig'),
            privateKey: privateKey('support-sig'),
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
