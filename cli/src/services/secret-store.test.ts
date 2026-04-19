import { describe, expect, it } from 'vitest';
import type { KeychainBackend } from './secret-store';
import { createSecretStore } from './secret-store';

describe('secret-store', () => {
  it('serializes and restores structured secrets through backend', async () => {
    const values = new Map<string, string>();
    const backend: KeychainBackend = {
      async get(account) {
        return values.get(account) ?? null;
      },
      async set(account, value) {
        values.set(account, value);
      },
      async delete(account) {
        return values.delete(account);
      },
    };
    const store = createSecretStore(backend);

    await store.setOidcSession('default', {
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234,
      createdAt: 5678,
    });

    expect(await store.getOidcSession('default')).toEqual({
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234,
      createdAt: 5678,
    });
    expect(await store.deleteOidcSession('default')).toBe(true);
    expect(await store.getOidcSession('default')).toBeNull();
  });

  it('surfaces backend failures', async () => {
    const backend: KeychainBackend = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('boom');
      },
      async delete() {
        return false;
      },
    };
    const store = createSecretStore(backend);

    await expect(
      store.setAgentKeyPair('default', {
        encryption: {
          publicKey: 'pub',
          privateKey: 'priv',
          keyVersion: 'enc-v1',
          algorithm: 'ecdh-p256-v1',
        },
        signing: {
          publicKey: 'pub',
          privateKey: 'priv',
          keyVersion: 'sig-v1',
          algorithm: 'ecdsa-p256-sha256-v1',
        },
      })
    ).rejects.toThrow('boom');
  });
});
