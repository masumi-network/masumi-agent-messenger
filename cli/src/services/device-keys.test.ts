import { describe, expect, it } from 'vitest';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type { SharedActorKeyMaterial } from '../../../shared/device-sharing';
import type { ResolvedProfile } from './config-store';
import type { KeychainBackend } from './secret-store';
import { createSecretStore } from './secret-store';
import {
  ensureNamespaceVaultContainsDefaultActor,
  exportNamespaceKeyShareSnapshot,
  importNamespaceKeyShareSnapshot,
} from './device-keys';

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
        email: 'agent@example.com',
      },
      actor: {
        id: '2',
        slug: 'live',
        publicIdentity: 'live',
        displayName: 'Live',
      },
      keyVersions: {
        encryption: 1,
        signing: 1,
      },
      updatedAt: '2026-04-15T00:00:00.000Z',
    },
  };
}

function createKeyPair(suffix: string, version: number): AgentKeyPair {
  return {
    encryption: {
      publicKey: `enc-pub-${suffix}`,
      privateKey: `enc-priv-${suffix}`,
      keyVersion: version,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: `sig-pub-${suffix}`,
      privateKey: `sig-priv-${suffix}`,
      keyVersion: version,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function createOverride(): SharedActorKeyMaterial {
  return {
    identity: {
      email: 'agent@example.com',
      slug: 'live',
    },
    current: createKeyPair('override', 2),
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

    expect(snapshot.email).toBe('agent@example.com');
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

  it('keeps the previous current key archived when importing a rotated device snapshot', async () => {
    const secretStore = createSecretStore(createMemoryBackend());
    const profile = createProfile();
    const previous = createKeyPair('previous', 1);
    const rotated = createKeyPair('rotated', 2);

    await secretStore.setAgentKeyPair(profile.name, previous);
    await secretStore.setNamespaceKeyVault(profile.name, {
      version: 1,
      email: 'agent@example.com',
      actors: [
        {
          identity: {
            email: 'agent@example.com',
            slug: 'live',
          },
          current: previous,
          archived: [],
        },
      ],
    });

    await importNamespaceKeyShareSnapshot({
      profile,
      secretStore,
      snapshot: {
        version: 1,
        email: 'agent@example.com',
        createdAt: '2026-05-12T00:00:00.000Z',
        actors: [
          {
            identity: {
              email: 'agent@example.com',
              slug: 'live',
            },
            current: rotated,
            archived: [],
          },
        ],
      },
    });

    expect(await secretStore.getAgentKeyPair(profile.name)).toEqual(rotated);
    expect(await secretStore.getNamespaceKeyVault(profile.name)).toEqual({
      version: 1,
      email: 'agent@example.com',
      actors: [
        {
          identity: {
            email: 'agent@example.com',
            slug: 'live',
          },
          current: rotated,
          archived: [previous],
        },
      ],
    });
  });

  it('archives the existing default key when syncing a new default key into the vault', async () => {
    const secretStore = createSecretStore(createMemoryBackend());
    const profile = createProfile();
    const previous = createKeyPair('previous', 1);
    const current = createKeyPair('current', 2);

    await secretStore.setNamespaceKeyVault(profile.name, {
      version: 1,
      email: 'agent@example.com',
      actors: [
        {
          identity: {
            email: 'agent@example.com',
            slug: 'live',
          },
          current: previous,
          archived: [],
        },
      ],
    });

    await ensureNamespaceVaultContainsDefaultActor({
      profile,
      secretStore,
      keyPair: current,
    });

    expect(await secretStore.getNamespaceKeyVault(profile.name)).toEqual({
      version: 1,
      email: 'agent@example.com',
      actors: [
        {
          identity: {
            email: 'agent@example.com',
            slug: 'live',
          },
          current,
          archived: [previous],
        },
      ],
    });
  });
});
