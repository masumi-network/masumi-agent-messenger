import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  getMasumiInboxAgentNetwork,
} from '../../../shared/inbox-agent-registration';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  actors: [] as unknown[],
  conn: {
    reducers: {
      upsertMasumiInboxAgentRegistration: vi.fn(),
    },
  },
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  readInboxRows: vi.fn(),
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
  readInboxRows: mocks.readInboxRows,
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
        | 'masumiRegistrationNetwork'
        | 'masumiInboxAgentId'
        | 'masumiAgentIdentifier'
        | 'masumiRegistrationState'
      >
    >
): VisibleAgentRow {
  return {
    ...row,
    publicDescription: undefined,
    publicLinkedEmailEnabled: false,
    allowAllMessageContentTypes: false,
    allowAllMessageHeaders: false,
    supportedMessageContentTypes: undefined,
    supportedMessageHeaderNames: undefined,
    currentEncryptionAlgorithm: 'ecdh-p256-v1',
    currentSigningAlgorithm: 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  };
}

describe('listOwnedInboxAgents', () => {
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
      registrationState: 'RegistrationConfirmed',
      registration: {
        status: 'registered',
        registrationState: 'RegistrationConfirmed',
      },
    });
    expect(mocks.conn.reducers.upsertMasumiInboxAgentRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:owner',
      masumiRegistrationState: 'RegistrationConfirmed',
    });
  });
});
