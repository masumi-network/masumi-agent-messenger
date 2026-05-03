import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { getMasumiInboxAgentNetwork } from '../../../shared/inbox-agent-registration';
import type { Agent } from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  actors: [] as Agent[],
  conn: {
    reducers: {
      upsertMasumiRegistration: vi.fn(),
    },
  },
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  loadProfile: vi.fn(),
  readAccounts: vi.fn(),
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
  readAccounts: mocks.readAccounts,
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
    Agent,
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
  > &
    Partial<
      Pick<
        Agent,
        | 'publicDescription'
        | 'publicLinkedEmailEnabled'
        | 'allowAllMessageContentTypes'
        | 'allowAllMessageHeaders'
        | 'supportedMessageContentTypes'
        | 'supportedMessageHeaderNames'
        | 'masumiRegistrationNetwork'
        | 'masumiInboxAgentId'
        | 'masumiAgentIdentifier'
      >
    > & {
      masumiRegistrationState?: string;
    }
): Agent {
  return {
    ...row,
    publicDescription: row.publicDescription ?? undefined,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes ?? [],
    supportedMessageHeaderNames: row.supportedMessageHeaderNames ?? [],
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: granularStateToRow(row.masumiRegistrationState),
  };
}

function granularStateToRow(state: string | undefined) {
  switch (state) {
    case 'RegistrationRequested':
    case 'RegistrationInitiated':
      return { tag: 'PendingRegistration' as const };
    case 'RegistrationConfirmed':
      return { tag: 'Registered' as const };
    case 'RegistrationFailed':
    case 'DeregistrationFailed':
      return { tag: 'Failed' as const };
    case 'DeregistrationRequested':
    case 'DeregistrationInitiated':
      return { tag: 'PendingDeregistration' as const };
    case 'DeregistrationConfirmed':
      return { tag: 'Deregistered' as const };
    default:
      return undefined;
  }
}

describe('getOwnedAgentProfile', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    mocks.actors = [];
    mocks.conn.reducers.upsertMasumiRegistration.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.saveActiveAgentSlug.mockReset();
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
    mocks.readAccounts.mockImplementation(() => ({
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
        accountId: 10n,
        email: 'owner@example.com',
        slug: 'owner',
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentKeyBundleVersion: 1,
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
      registrationState: 'Registered',
    });
    expect(mocks.conn.reducers.upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: { tag: 'Registered' },
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
        accountId: 10n,
        email: 'owner@example.com',
        slug: 'owner',
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentKeyBundleVersion: 1,
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
    expect(mocks.conn.reducers.upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: { tag: 'Registered' },
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
        accountId: 10n,
        email: 'owner@example.com',
        slug: 'owner',
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentKeyBundleVersion: 1,
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
      registrationState: 'Registered',
    });
    expect(mocks.saveActiveAgentSlug).toHaveBeenCalledWith('default', 'owner');
  });

  it('refuses to select an agent that syncs as deregistered', async () => {
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
              status: 'Deregistered',
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
        accountId: 10n,
        email: 'owner@example.com',
        slug: 'owner',
        isDefault: true,
        publicIdentity: 'owner',
        displayName: 'Owner',
        currentKeyBundleVersion: 1,
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:owner',
        masumiRegistrationState: 'RegistrationConfirmed',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
    ];

    await expect(
      useOwnedAgent({
        profileName: 'default',
        actorSlug: 'owner',
        reporter: {
          info() {},
          success() {},
        },
      })
    ).rejects.toMatchObject({
      code: 'AGENT_DEREGISTERED',
    });
    expect(mocks.saveActiveAgentSlug).not.toHaveBeenCalled();
    expect(mocks.conn.reducers.upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: { tag: 'Deregistered' },
    });
  });
});
