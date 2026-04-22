import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { Agent } from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  iterVisibleAgents: vi.fn(),
  unsubscribe: vi.fn(),
  connectAuthenticated: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
}));

import { createChannel } from './channel';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function actor(row: Partial<Agent> & Pick<Agent, 'id' | 'inboxId' | 'slug'>): Agent {
  return {
    id: row.id,
    inboxId: row.inboxId,
    normalizedEmail: row.normalizedEmail ?? 'owner@example.com',
    slug: row.slug,
    inboxIdentifier: row.inboxIdentifier,
    isDefault: row.isDefault ?? true,
    publicIdentity: row.publicIdentity ?? row.slug,
    displayName: row.displayName,
    currentEncryptionPublicKey: row.currentEncryptionPublicKey ?? 'enc',
    currentEncryptionKeyVersion: row.currentEncryptionKeyVersion ?? 'enc-v1',
    currentSigningPublicKey: row.currentSigningPublicKey ?? 'sig',
    currentSigningKeyVersion: row.currentSigningKeyVersion ?? 'sig-v1',
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    publicDescription: row.publicDescription,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes,
    supportedMessageHeaderNames: row.supportedMessageHeaderNames,
    currentEncryptionAlgorithm: row.currentEncryptionAlgorithm ?? 'ecdh-p256-v1',
    currentSigningAlgorithm: row.currentSigningAlgorithm ?? 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  } as Agent;
}

function makeConnection() {
  return {
    reducers: {
      createChannel: mocks.createChannel,
    },
    db: {
      visibleAgents: {
        iter: mocks.iterVisibleAgents,
      },
      publicChannel: {
        iter: () => [],
      },
      visibleChannels: {
        iter: () => [],
      },
      visibleChannelMemberships: {
        iter: () => [],
      },
      visibleChannelJoinRequests: {
        iter: () => [],
      },
    },
    subscriptionBuilder() {
      let applied: (() => void) | null = null;
      return {
        onApplied(callback: () => void) {
          applied = callback;
          return this;
        },
        onError() {
          return this;
        },
        subscribe() {
          queueMicrotask(() => applied?.());
          return {
            unsubscribe: mocks.unsubscribe,
          };
        },
      };
    },
  };
}

describe('channel mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.createChannel.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.ensureAuthenticatedSession.mockReset();
    mocks.iterVisibleAgents.mockReset();
    mocks.unsubscribe.mockReset();
    mocks.connectAuthenticated.mockReset();
    mocks.ensureAuthenticatedSession.mockResolvedValue({
      profile: {
        name: 'default',
        issuer: 'https://issuer.example.com',
        clientId: 'client-id',
        oidcScope: 'openid profile email',
        spacetimeHost: 'ws://localhost:3000',
        spacetimeDbName: 'agentmessenger-dev',
      },
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      claims: {
        email: 'owner@example.com',
      },
    });
    mocks.connectAuthenticated.mockResolvedValue({
      conn: makeConnection(),
    });
  });

  it('refuses channel mutations from a default agent with pending deregistration', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
        masumiRegistrationState: 'DeregistrationRequested',
      }),
    ]);

    await expect(
      createChannel({
        profileName: 'default',
        slug: 'ops',
        accessMode: 'public',
        discoverable: true,
        reporter: {
          info() {},
          success() {},
          verbose() {},
        },
      })
    ).rejects.toMatchObject({
      code: 'AGENT_DEREGISTERED',
    });

    expect(mocks.createChannel).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.disconnectConnection).toHaveBeenCalledOnce();
  });
});
