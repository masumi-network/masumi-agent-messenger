import { describe, expect, it } from 'vitest';
import type { SharedActorKeyMaterial } from '../../../shared/device-sharing';
import type { ResolvedProfile } from './config-store';
import type { KeychainBackend } from './secret-store';
import { createSecretStore } from './secret-store';
import { exportNamespaceKeyShareSnapshot } from './device-keys';

function createMemoryBackend(): KeychainBackend {
  const values = new Map<string, string>();
  return {
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
}

function createProfile(): ResolvedProfile {
  return {
    name: 'default',
    issuer: 'https://issuer.example',
    clientId: 'cli',
    oidcScope: 'openid profile email',
    spacetimeHost: 'http://localhost:3000',
    spacetimeDbName: 'agentmessenger-dev',
    bootstrapSnapshot: {
      email: 'agent@example.com',
      spacetimeIdentity: 'identity',
      inbox: {
        id: '1',
        normalizedEmail: 'agent@example.com',
        displayEmail: 'agent@example.com',
      },
      actor: {
        id: '2',
        slug: 'live',
        publicIdentity: 'live',
        displayName: 'Live',
      },
      keyVersions: {
        encryption: 'enc-v1',
        signing: 'sig-v1',
      },
      updatedAt: '2026-04-15T00:00:00.000Z',
    },
  };
}

function createOverride(): SharedActorKeyMaterial {
  return {
    identity: {
      normalizedEmail: 'agent@example.com',
      slug: 'live',
      inboxIdentifier: 'live',
    },
    current: {
      encryption: {
        publicKey: 'enc-pub',
        privateKey: 'enc-priv',
        keyVersion: 'enc-v2',
        algorithm: 'ecdh-p256-v1',
      },
      signing: {
        publicKey: 'sig-pub',
        privateKey: 'sig-priv',
        keyVersion: 'sig-v2',
        algorithm: 'ecdsa-p256-sha256-v1',
      },
    },
    archived: [],
  };
}

describe('device-keys', () => {
  it('exports override key material when local keys are otherwise missing', async () => {
    const secretStore = createSecretStore(createMemoryBackend());
    const snapshot = await exportNamespaceKeyShareSnapshot({
      profile: createProfile(),
      secretStore,
      overrides: [createOverride()],
    });

    expect(snapshot.normalizedEmail).toBe('agent@example.com');
    expect(snapshot.actors).toEqual([createOverride()]);
  });

  it('still rejects export when no local or override key material exists', async () => {
    const secretStore = createSecretStore(createMemoryBackend());

    await expect(
      exportNamespaceKeyShareSnapshot({
        profile: createProfile(),
        secretStore,
      })
    ).rejects.toThrow('No local private key material is available to share from this CLI profile.');
  });
});
