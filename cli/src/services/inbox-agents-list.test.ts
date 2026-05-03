import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  getMasumiInboxAgentNetwork,
} from '../../../shared/inbox-agent-registration';
import type { Agent } from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  actors: [] as unknown[],
  conn: {
    reducers: {
      upsertMasumiRegistration: vi.fn(),
    },
  },
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  readAccounts: vi.fn(),
  subscribeInboxTables: vi.fn(),
  unsubscribe: vi.fn(),
  connectAuthenticated: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
  readAccounts: mocks.readAccounts,
  subscribeInboxTables: mocks.subscribeInboxTables,
}));

import { listOwnedInboxAgents } from './inbox-agents';

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
    publicDescription: undefined,
    publicLinkedEmailEnabled: false,
    allowAllMessageContentTypes: false,
    allowAllMessageHeaders: false,
    supportedMessageContentTypes: [],
    supportedMessageHeaderNames: [],
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

describe('listOwnedInboxAgents', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    mocks.actors = [];
    mocks.conn.reducers.upsertMasumiRegistration.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.unsubscribe.mockReset();
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

  it('refreshes stale pending registration state before returning list rows', async () => {
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

    const result = await listOwnedInboxAgents({
      profileName: 'default',
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.agents[0]).toMatchObject({
      slug: 'owner',
      agentIdentifier: 'did:masumi:owner',
      registrationState: 'Registered',
      registration: {
        status: 'registered',
        registrationState: 'RegistrationConfirmed',
      },
    });
    expect(mocks.conn.reducers.upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: { tag: 'Registered' },
    });
  });
});
