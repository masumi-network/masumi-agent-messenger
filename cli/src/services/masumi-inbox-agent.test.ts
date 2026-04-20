import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  createRegistrationFailedMetadata,
  createRegistrationRequestedMetadata,
  getMasumiInboxAgentNetwork,
  registrationResultFromMetadata,
} from '../../../shared/inbox-agent-registration';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';
import {
  applyRegistrationMetadataToActor,
  findMasumiInboxAgents,
  listMasumiInboxAgents,
  lookupMasumiInboxAgentBySlug,
  syncMasumiInboxAgentRegistration,
} from './masumi-inbox-agent';

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

const configuredNetwork = getMasumiInboxAgentNetwork();

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
        | 'currentEncryptionAlgorithm'
        | 'currentSigningAlgorithm'
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
    currentEncryptionAlgorithm: row.currentEncryptionAlgorithm ?? 'ecdh-p256-v1',
    currentSigningAlgorithm: row.currentSigningAlgorithm ?? 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
  };
}

describe('applyRegistrationMetadataToActor', () => {
  it('applies registration metadata after syncing registration state', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 1n,
        inboxId: 10n,
        normalizedEmail: 'agent@example.com',
        slug: 'agent',
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      {
        masumiRegistrationNetwork: 'Preprod',
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:agent-123',
        masumiRegistrationState: 'RegistrationConfirmed',
      }
    );

    expect(result.masumiRegistrationNetwork).toBe('Preprod');
    expect(result.masumiInboxAgentId).toBe('agent-123');
    expect(result.masumiAgentIdentifier).toBe('did:masumi:agent-123');
    expect(result.masumiRegistrationState).toBe('RegistrationConfirmed');
  });

  it('applies registration metadata to non-default inbox actors too', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 2n,
        inboxId: 10n,
        normalizedEmail: 'agent@example.com',
        slug: 'planner-bot',
        inboxIdentifier: 'planner-bot',
        isDefault: false,
        publicIdentity: 'planner-bot',
        displayName: 'Planner Bot',
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      {
        masumiRegistrationNetwork: 'Preprod',
        masumiInboxAgentId: 'agent-456',
        masumiAgentIdentifier: 'did:masumi:agent-456',
        masumiRegistrationState: 'RegistrationConfirmed',
      }
    );

    expect(result.isDefault).toBe(false);
    expect(result.slug).toBe('planner-bot');
    expect(result.masumiInboxAgentId).toBe('agent-456');
    expect(result.masumiAgentIdentifier).toBe('did:masumi:agent-456');
    expect(result.masumiRegistrationState).toBe('RegistrationConfirmed');
  });

  it('preserves linked email visibility while applying registration metadata', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 3n,
        inboxId: 10n,
        normalizedEmail: 'agent@example.com',
        slug: 'agent',
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        publicLinkedEmailEnabled: true,
        currentEncryptionPublicKey: 'enc',
        currentEncryptionKeyVersion: 'enc-v1',
        currentSigningPublicKey: 'sig',
        currentSigningKeyVersion: 'sig-v1',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      {
        masumiRegistrationNetwork: 'Preprod',
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:agent-789',
        masumiRegistrationState: 'RegistrationConfirmed',
      }
    );

    expect(result.publicLinkedEmailEnabled).toBe(true);
  });

  it('creates a local requested registration marker without treating the actor as already registered', () => {
    const metadata = createRegistrationRequestedMetadata({
      current: null,
    });

    expect(metadata.masumiRegistrationNetwork).toBe(configuredNetwork);
    expect(metadata.masumiInboxAgentId).toBeUndefined();
    expect(metadata.masumiAgentIdentifier).toBeUndefined();
    expect(metadata.masumiRegistrationState).toBe('RegistrationRequested');
    expect(registrationResultFromMetadata(metadata).status).toBe('pending');
  });

  it('maps shared registration states to owner-facing outcomes', () => {
    expect(
      registrationResultFromMetadata({
        masumiRegistrationState: 'RegistrationInitiated',
      }).status
    ).toBe('pending');
    expect(
      registrationResultFromMetadata({
        masumiRegistrationState: 'RegistrationConfirmed',
        masumiAgentIdentifier: 'did:masumi:agent',
      }).status
    ).toBe('registered');
    expect(
      registrationResultFromMetadata({
        masumiRegistrationState: 'RegistrationFailed',
      }).status
    ).toBe('failed');
    expect(
      registrationResultFromMetadata({
        masumiRegistrationState: 'DeregistrationFailed',
      }).status
    ).toBe('failed');
    expect(registrationResultFromMetadata(null).status).toBe('skipped');
  });

  it('creates a local failed registration marker without keeping stale registration state', () => {
    const metadata = createRegistrationFailedMetadata({
      current: {
        masumiRegistrationNetwork: 'Preprod',
        masumiInboxAgentId: 'stale-id',
        masumiAgentIdentifier: 'did:masumi:stale-id',
        masumiRegistrationState: 'RegistrationConfirmed',
      },
    });

    expect(metadata.masumiRegistrationState).toBe('RegistrationFailed');
    expect(metadata.masumiInboxAgentId).toBeUndefined();
    expect(metadata.masumiAgentIdentifier).toBeUndefined();
    expect(registrationResultFromMetadata(metadata).status).toBe('failed');
  });
});

describe('findMasumiInboxAgents', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the verified SaaS search endpoint for fuzzy discovery queries', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'verified-agent',
                name: 'Verified Agent',
                description: null,
                agentSlug: 'verified-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:verified-agent',
              },
              {
                id: 'another-verified-agent',
                name: 'Another Verified Agent',
                description: null,
                agentSlug: 'another-verified-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:another-verified-agent',
              },
              {
                id: 'missing-identifier',
                name: 'Missing Identifier',
                description: null,
                agentSlug: 'missing-identifier',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: null,
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await findMasumiInboxAgents({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      search: 'agent',
      take: 10,
    });

    expect(result.map(entry => entry.agentSlug)).toEqual([
      'verified-agent',
      'another-verified-agent',
      'missing-identifier',
    ]);
    const calls = vi.mocked(global.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration-search?network=${configuredNetwork}`
    );
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
        body: JSON.stringify({
          network: configuredNetwork,
          query: 'agent',
          limit: 10,
          filter: {
            status: ['Verified'],
          },
        }),
      })
    );
    expect(calls).toHaveLength(1);
  });

  it('can include pending registrations and fall back to exact slug lookup', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'lisa-kuepers',
                name: 'Lisa Kuepers',
                description: null,
                agentSlug: 'lisa-kuepers',
                status: 'Pending',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:lisa',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'lisa-kuepers',
                name: 'Lisa Kuepers',
                description: null,
                agentSlug: 'lisa-kuepers',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:05:00.000Z',
                statusUpdatedAt: '2026-04-14T00:05:00.000Z',
                agentIdentifier: 'did:masumi:lisa',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await findMasumiInboxAgents({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      search: 'Lisa-kuepers',
      take: 10,
      allowPending: true,
    });

    expect(result.map(entry => entry.agentSlug)).toEqual(['lisa-kuepers']);
    expect(result[0]?.state).toBe('RegistrationConfirmed');
    const calls = vi.mocked(global.fetch).mock.calls;
    expect(String(calls[1]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          network: configuredNetwork,
          limit: 10,
          filter: {
            agentSlug: 'lisa-kuepers',
            status: ['Pending', 'Verified'],
          },
        }),
      })
    );
    expect(calls[2]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          network: configuredNetwork,
          limit: 20,
          filter: {
            agentSlug: 'lisa-kuepers',
            status: ['Pending', 'Verified'],
          },
        }),
      })
    );
  });

  it('falls back to linked-email lookup when text search returns no registrations', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'elena',
                name: 'Elena',
                description: null,
                agentSlug: 'elena-serviceplan-agents-com',
                linkedEmail: 'elena@serviceplan-agents.com',
                status: 'Pending',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:elena',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'elena',
                name: 'Elena',
                description: null,
                agentSlug: 'elena-serviceplan-agents-com',
                linkedEmail: 'elena@serviceplan-agents.com',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:05:00.000Z',
                statusUpdatedAt: '2026-04-14T00:05:00.000Z',
                agentIdentifier: 'did:masumi:elena',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await findMasumiInboxAgents({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      search: 'elena@serviceplan-agents.com',
      take: 10,
      allowPending: true,
    });

    expect(result.map(entry => entry.agentSlug)).toEqual(['elena-serviceplan-agents-com']);
    expect(result[0]?.state).toBe('RegistrationConfirmed');
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(4);
  });
});

describe('listMasumiInboxAgents', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the registry inbox-agent-registration endpoint for browse pagination', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'registered-agent',
                name: 'Registered Agent',
                description: null,
                agentSlug: 'registered-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:registered-agent',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'second-agent',
                name: 'Second Agent',
                description: null,
                agentSlug: 'second-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:second-agent',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await listMasumiInboxAgents({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      take: 1,
      page: 2,
      allowPending: true,
    });

    expect(result.agents.map(entry => entry.agentSlug)).toEqual(['second-agent']);
    expect(result.page).toBe(2);
    expect(result.take).toBe(1);
    const calls = vi.mocked(global.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
        body: JSON.stringify({
          network: configuredNetwork,
          limit: 1,
          filter: {
            status: ['Pending', 'Verified'],
          },
        }),
      })
    );
    expect(String(calls[1]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
        body: JSON.stringify({
          network: configuredNetwork,
          limit: 1,
          cursorId: 'registered-agent',
          filter: {
            status: ['Pending', 'Verified'],
          },
        }),
      })
    );
    expect(calls).toHaveLength(2);
  });

  it('refreshes pending browse entries with exact slug lookups before returning', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'pending-agent',
                name: 'Pending Agent',
                description: null,
                agentSlug: 'pending-agent',
                status: 'Pending',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:pending-agent',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'pending-agent',
                name: 'Pending Agent',
                description: null,
                agentSlug: 'pending-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:05:00.000Z',
                statusUpdatedAt: '2026-04-14T00:05:00.000Z',
                agentIdentifier: 'did:masumi:pending-agent',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await listMasumiInboxAgents({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      take: 10,
      allowPending: true,
    });

    expect(result.agents[0]?.state).toBe('RegistrationConfirmed');
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('uses exact slug lookup and refreshes pending entries for direct lookup', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'direct-agent',
                name: 'Direct Agent',
                description: null,
                agentSlug: 'direct-agent',
                status: 'Pending',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:00:00.000Z',
                statusUpdatedAt: '2026-04-14T00:00:00.000Z',
                agentIdentifier: 'did:masumi:direct-agent',
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          data: {
            registrations: [
              {
                id: 'direct-agent',
                name: 'Direct Agent',
                description: null,
                agentSlug: 'direct-agent',
                status: 'Verified',
                createdAt: '2026-04-14T00:00:00.000Z',
                updatedAt: '2026-04-14T00:05:00.000Z',
                statusUpdatedAt: '2026-04-14T00:05:00.000Z',
                agentIdentifier: 'did:masumi:direct-agent',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await lookupMasumiInboxAgentBySlug({
      issuer: 'https://issuer.example.com',
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      slug: 'direct-agent',
    });

    expect(result?.state).toBe('RegistrationConfirmed');
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });
});

describe('syncMasumiInboxAgentRegistration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refreshes stale pending state from the registry even when an agent identifier exists', async () => {
    const upsertMasumiInboxAgentRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-123',
              name: 'Agent',
              description: 'Registered agent',
              agentSlug: 'agent',
              linkedEmail: null,
              status: 'Verified',
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-15T00:00:00.000Z',
              statusUpdatedAt: '2026-04-15T00:10:00.000Z',
              agentIdentifier: 'did:masumi:agent',
            },
          ],
        },
      })
    ) as typeof fetch;

    const result = await syncMasumiInboxAgentRegistration({
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
      conn: {
        reducers: {
          upsertMasumiInboxAgentRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'agent@example.com',
          slug: 'agent',
          inboxIdentifier: undefined,
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentEncryptionPublicKey: 'enc',
          currentEncryptionKeyVersion: 'enc-v1',
          currentSigningPublicKey: 'sig',
          currentSigningKeyVersion: 'sig-v1',
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: 'RegistrationRequested',
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.inboxAgentId).toBe('agent-123');
    expect(result.registration.agentIdentifier).toBe('did:masumi:agent');
    expect(result.registration.registrationState).toBe('RegistrationConfirmed');
    expect(upsertMasumiInboxAgentRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:agent',
      masumiRegistrationState: 'RegistrationConfirmed',
    });

    const calls = vi.mocked(global.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
    expect(calls).toHaveLength(1);
  });

  it('preserves last known registration state when registry refresh fails', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('registry offline')) as typeof fetch;

    const result = await syncMasumiInboxAgentRegistration({
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
      conn: {
        reducers: {
          upsertMasumiInboxAgentRegistration: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'agent@example.com',
          slug: 'agent',
          inboxIdentifier: undefined,
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentEncryptionPublicKey: 'enc',
          currentEncryptionKeyVersion: 'enc-v1',
          currentSigningPublicKey: 'sig',
          currentSigningKeyVersion: 'sig-v1',
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: 'RegistrationRequested',
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('agent-123');
    expect(result.registration.agentIdentifier).toBe('did:masumi:agent');
    expect(result.registration.registrationState).toBe('RegistrationRequested');
    expect(result.registration.error).toBe('registry offline');
  });
});
