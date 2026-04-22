import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { getMasumiInboxAgentNetwork } from '../../../shared/inbox-agent-registration';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  actors: [] as VisibleAgentRow[],
  conn: {
    reducers: {
      upsertMasumiInboxAgentRegistration: vi.fn(),
    },
  },
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  loadProfile: vi.fn(),
  readInboxRows: vi.fn(),
  saveActiveAgentSlug: vi.fn(),
  subscribeInboxTables: vi.fn(),
  unsubscribe: vi.fn(),
  connectAuthenticated: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('./config-store', () => ({
  loadProfile: mocks.loadProfile,
  saveActiveAgentSlug: mocks.saveActiveAgentSlug,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
  readInboxRows: mocks.readInboxRows,
  subscribeInboxTables: mocks.subscribeInboxTables,
}));

import { getOwnedAgentProfile, listOwnedAgents, useOwnedAgent } from './agent-state';

const configuredNetwork = getMasumiInboxAgentNetwork();
const originalFetch = global.fetch;

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function actor(
  row: Omit<
    VisibleAgentRow,
    | 'masumiRegistrationNetwork'
    | 'masumiInboxAgentId'
    | 'masumiAgentIdentifier'
    | 'masumiRegistrationState'
    | 'publicDescription'
    | 'publicLinkedEmailEnabled'
    | 'allowAllMessageContentTypes'
    | 'allowAllMessageHeaders'
    | 'supportedMessageContentTypes'
    | 'supportedMessageHeaderNames'
    | 'currentEncryptionAlgorithm'
    | 'currentSigningAlgorithm'
  > &
    Partial<
      Pick<
        VisibleAgentRow,
        | 'publicDescription'
        | 'publicLinkedEmailEnabled'
        | 'allowAllMessageContentTypes'
        | 'allowAllMessageHeaders'
        | 'supportedMessageContentTypes'
        | 'supportedMessageHeaderNames'
        | 'masumiRegistrationNetwork'
        | 'masumiInboxAgentId'
        | 'masumiAgentIdentifier'
        | 'masumiRegistrationState'
      >
    >
): VisibleAgentRow {
  return {
    ...row,
    publicDescription: row.publicDescription ?? undefined,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes,
    supportedMessageHeaderNames: row.supportedMessageHeaderNames,
    currentEncryptionAlgorithm: 'ecdh-p256-v1',
    currentSigningAlgorithm: 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  };
}

describe('getOwnedAgentProfile', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    mocks.actors = [];
    mocks.conn.reducers.upsertMasumiInboxAgentRegistration.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.unsubscribe.mockReset();
    mocks.loadProfile.mockResolvedValue({
      name: 'default',
      issuer: 'https://issuer.example.com',
      clientId: 'client-id',
      oidcScope: 'openid profile email',
      activeAgentSlug: 'owner',
      spacetimeHost: 'ws://localhost:3000',
      spacetimeDbName: 'agentmessenger-dev',
    });
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
      conn: mocks.conn,
    });
    mocks.subscribeInboxTables.mockResolvedValue({
      unsubscribe: mocks.unsubscribe,
    });
    mocks.readInboxRows.mockImplementation(() => ({
      actors: mocks.actors,
    }));
  });

  it('refreshes stale registration metadata before returning the profile', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-123',
              name: 'Owner',
              description: null,
              agentSlug: 'owner',
              status: 'Verified',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:05:00.000Z',
              statusUpdatedAt: '2026-04-15T10:05:00.000Z',
              agentIdentifier: 'did:masumi:owner',
            },
          ],
        },
      })
    ) as typeof fetch;
    mocks.actors = [
      actor({
        id: 1n,
        inboxId: 10n,
        normalizedEmail: 'owner@example.com',
        slug: 'owner',
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:owner',
        masumiRegistrationState: 'RegistrationRequested',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
    ];

    const result = await getOwnedAgentProfile({
      profileName: 'default',
      actorSlug: 'owner',
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.agent).toMatchObject({
      slug: 'owner',
      managed: true,
      registered: true,
      agentIdentifier: 'did:masumi:owner',
      registrationState: 'RegistrationConfirmed',
    });
    expect(mocks.conn.reducers.upsertMasumiInboxAgentRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: 'RegistrationConfirmed',
    });
  });

  it('refreshes stale registration metadata before returning list summaries', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-123',
              name: 'Owner',
              description: null,
              agentSlug: 'owner',
              status: 'Verified',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:05:00.000Z',
              statusUpdatedAt: '2026-04-15T10:05:00.000Z',
              agentIdentifier: 'did:masumi:owner',
            },
          ],
        },
      })
    ) as typeof fetch;
    mocks.actors = [
      actor({
        id: 1n,
        inboxId: 10n,
        normalizedEmail: 'owner@example.com',
        slug: 'owner',
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:owner',
        masumiRegistrationState: 'RegistrationRequested',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
    ];

    const result = await listOwnedAgents({
      profileName: 'default',
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.agents[0]).toMatchObject({
      slug: 'owner',
      managed: true,
      registered: true,
    });
    expect(mocks.conn.reducers.upsertMasumiInboxAgentRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: 'RegistrationConfirmed',
    });
  });

  it('refreshes stale registration metadata while switching active agents', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-123',
              name: 'Owner',
              description: null,
              agentSlug: 'owner',
              status: 'Verified',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:05:00.000Z',
              statusUpdatedAt: '2026-04-15T10:05:00.000Z',
              agentIdentifier: 'did:masumi:owner',
            },
          ],
        },
      })
    ) as typeof fetch;
    mocks.actors = [
      actor({
        id: 1n,
        inboxId: 10n,
        normalizedEmail: 'owner@example.com',
        slug: 'owner',
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:owner',
        masumiRegistrationState: 'RegistrationRequested',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
    ];

    const result = await useOwnedAgent({
      profileName: 'default',
      actorSlug: 'owner',
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.agent).toMatchObject({
      slug: 'owner',
      managed: true,
      registered: true,
      registrationState: 'RegistrationConfirmed',
    });
    expect(mocks.saveActiveAgentSlug).toHaveBeenCalledWith('default', 'owner');
  });
});
