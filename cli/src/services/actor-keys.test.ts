import { describe, expect, it } from 'vitest';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type { ResolvedProfile } from './config-store';
import type { KeychainBackend } from './secret-store';
import { createSecretStore } from './secret-store';
import { resolveStoredActorKeyPairForPublishedActor } from './actor-keys';

function createKeyPair(suffix: string): AgentKeyPair {
  return {
    encryption: {
      publicKey: `enc-pub-${suffix}`,
      privateKey: `enc-priv-${suffix}`,
      keyVersion: `enc-${suffix}`,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: `sig-pub-${suffix}`,
      privateKey: `sig-priv-${suffix}`,
      keyVersion: `sig-${suffix}`,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function createProfile(): ResolvedProfile {
  return {
    name: 'default',
    issuer: 'https://issuer.example',
    clientId: 'masumi-cli',
    oidcScope: 'openid profile email offline_access',
    spacetimeHost: 'http://localhost:3000',
    spacetimeDbName: 'agentmessenger-dev',
    bootstrapSnapshot: {
      email: 'agent@example.com',
      spacetimeIdentity: 'identity-1',
      inbox: {
        id: '1',
        normalizedEmail: 'agent@example.com',
        displayEmail: 'agent@example.com',
      },
      actor: {
        id: '7',
        slug: 'agent',
        publicIdentity: 'agent-public',
        displayName: 'Agent',
      },
      keyVersions: {
        encryption: 'enc-current',
        signing: 'sig-current',
      },
      updatedAt: '2026-04-15T00:00:00.000Z',
    },
  };
}

function createStore() {
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

  return createSecretStore(backend);
}

describe('resolveStoredActorKeyPairForPublishedActor', () => {
  it('promotes a matching archived key pair back to current storage', async () => {
    const profile = createProfile();
    const store = createStore();
    const stale = createKeyPair('stale');
    const matching = createKeyPair('current');

    await store.setAgentKeyPair(profile.name, stale);
    await store.setNamespaceKeyVault(profile.name, {
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: stale,
          archived: [matching],
        },
      ],
    });

    const result = await resolveStoredActorKeyPairForPublishedActor({
      profile,
      secretStore: store,
      identity: {
        normalizedEmail: 'agent@example.com',
        slug: 'agent',
      },
      published: {
        encryption: {
          publicKey: matching.encryption.publicKey,
          keyVersion: matching.encryption.keyVersion,
        },
        signing: {
          publicKey: matching.signing.publicKey,
          keyVersion: matching.signing.keyVersion,
        },
      },
    });

    expect(result).toEqual({
      status: 'matched',
      keyPair: matching,
    });
    expect(await store.getAgentKeyPair(profile.name)).toEqual(matching);
    expect(await store.getNamespaceKeyVault(profile.name)).toEqual({
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: matching,
          archived: [stale],
        },
      ],
    });
  });

  it('archives stale current keys and clears the default slot when nothing local matches', async () => {
    const profile = createProfile();
    const store = createStore();
    const stale = createKeyPair('stale');
    const published = createKeyPair('published');

    await store.setAgentKeyPair(profile.name, stale);
    await store.setNamespaceKeyVault(profile.name, {
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: stale,
          archived: [],
        },
      ],
    });

    const result = await resolveStoredActorKeyPairForPublishedActor({
      profile,
      secretStore: store,
      identity: {
        normalizedEmail: 'agent@example.com',
        slug: 'agent',
      },
      published: {
        encryption: {
          publicKey: published.encryption.publicKey,
          keyVersion: published.encryption.keyVersion,
        },
        signing: {
          publicKey: published.signing.publicKey,
          keyVersion: published.signing.keyVersion,
        },
      },
    });

    expect(result).toEqual({
      status: 'mismatch',
      keyPair: null,
    });
    expect(await store.getAgentKeyPair(profile.name)).toBeNull();
    expect(await store.getNamespaceKeyVault(profile.name)).toEqual({
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: null,
          archived: [stale],
        },
      ],
    });
  });

  it('treats archived-only stale keys as missing recovery material', async () => {
    const profile = createProfile();
    const store = createStore();
    const stale = createKeyPair('stale');
    const published = createKeyPair('published');

    await store.setNamespaceKeyVault(profile.name, {
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: null,
          archived: [stale],
        },
      ],
    });

    const result = await resolveStoredActorKeyPairForPublishedActor({
      profile,
      secretStore: store,
      identity: {
        normalizedEmail: 'agent@example.com',
        slug: 'agent',
      },
      published: {
        encryption: {
          publicKey: published.encryption.publicKey,
          keyVersion: published.encryption.keyVersion,
        },
        signing: {
          publicKey: published.signing.publicKey,
          keyVersion: published.signing.keyVersion,
        },
      },
    });

    expect(result).toEqual({
      status: 'missing',
      keyPair: null,
    });
    expect(await store.getAgentKeyPair(profile.name)).toBeNull();
    expect(await store.getNamespaceKeyVault(profile.name)).toEqual({
      version: 1,
      normalizedEmail: 'agent@example.com',
      actors: [
        {
          identity: {
            normalizedEmail: 'agent@example.com',
            slug: 'agent',
          },
          current: null,
          archived: [stale],
        },
      ],
    });
  });
});
