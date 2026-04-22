import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deregisterMasumiInboxAgentForSession,
  listMasumiInboxAgentsForSession,
  lookupMasumiInboxAgentForSession,
  prioritizeVerifiedMasumiInboxAgents,
  syncMasumiInboxAgentRegistrationForSession,
} from '@/lib/inbox-agent-registration.server';
import type { AuthenticatedRequestBrowserSession } from '@/lib/oidc-auth.server';
import {
  getMasumiInboxAgentNetwork,
  serializeMasumiRegistrationMetadata,
  type SerializedMasumiActorRegistrationSubject,
} from '../../../../shared/inbox-agent-registration';

const originalFetch = global.fetch;
const originalMasumiNetwork = process.env.MASUMI_NETWORK;
const configuredNetwork = getMasumiInboxAgentNetwork();

function testSession(): AuthenticatedRequestBrowserSession {
  return {
    authenticated: true,
    idToken: 'id-token',
    accessToken: 'access-token',
    grantedScopes: ['openid', 'profile', 'email'],
    expiresAt: '2026-04-16T00:00:00.000Z',
    user: {
      issuer: 'https://issuer.example.com',
      subject: 'user-123',
      audience: ['masumi-agent-messenger'],
      email: 'agent@example.com',
      emailVerified: true,
      name: 'Verified Agent',
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  if (originalMasumiNetwork === undefined) {
    delete process.env.MASUMI_NETWORK;
  } else {
    process.env.MASUMI_NETWORK = originalMasumiNetwork;
  }
  vi.restoreAllMocks();
});

describe('Masumi inbox-agent discovery ordering', () => {
  it('returns only verified SaaS search results', () => {
    const ordered = prioritizeVerifiedMasumiInboxAgents({
      entries: [
        {
          id: '1',
          name: 'Fallback Agent',
          description: null,
          agentSlug: 'fallback-agent',
          state: 'RegistrationConfirmed',
          createdAt: '2026-04-15T10:00:00.000Z',
          updatedAt: '2026-04-15T10:00:00.000Z',
          lastCheckedAt: null,
          agentIdentifier: 'agent-fallback',
        },
        {
          id: '2',
          name: 'Verified Agent',
          description: null,
          agentSlug: 'verified-agent',
          state: 'RegistrationConfirmed',
          createdAt: '2026-04-15T10:00:00.000Z',
          updatedAt: '2026-04-15T10:00:00.000Z',
          lastCheckedAt: null,
          agentIdentifier: 'agent-verified',
        },
      ],
      verifiedAgentIdentifiers: new Set(['agent-verified']),
    });

    expect(ordered.map(entry => entry.agentSlug)).toEqual(['verified-agent']);
  });

  it('returns no entries when none can be verified', () => {
    const ordered = prioritizeVerifiedMasumiInboxAgents({
      entries: [
        {
          id: '1',
          name: 'Raw Agent',
          description: null,
          agentSlug: 'raw-agent',
          state: 'RegistrationConfirmed',
          createdAt: '2026-04-15T10:00:00.000Z',
          updatedAt: '2026-04-15T10:00:00.000Z',
          lastCheckedAt: null,
          agentIdentifier: null,
        },
      ],
      verifiedAgentIdentifiers: new Set(),
    });

    expect(ordered).toEqual([]);
  });

  it('refreshes pending browse entries before returning them', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
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
                linkedEmail: null,
                status: 'Pending',
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                statusUpdatedAt: '2026-04-15T10:00:00.000Z',
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
                linkedEmail: null,
                status: 'Verified',
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:05:00.000Z',
                statusUpdatedAt: '2026-04-15T10:05:00.000Z',
                agentIdentifier: 'did:masumi:pending-agent',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await listMasumiInboxAgentsForSession({
      session: testSession(),
      take: 20,
      page: 1,
    });

    expect(result.agents[0]?.state).toBe('RegistrationConfirmed');
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('refreshes pending exact SaaS slug lookup before returning it', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
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
                linkedEmail: null,
                status: 'Pending',
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:00:00.000Z',
                statusUpdatedAt: '2026-04-15T10:00:00.000Z',
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
                linkedEmail: null,
                status: 'Verified',
                createdAt: '2026-04-15T10:00:00.000Z',
                updatedAt: '2026-04-15T10:05:00.000Z',
                statusUpdatedAt: '2026-04-15T10:05:00.000Z',
                agentIdentifier: 'did:masumi:direct-agent',
              },
            ],
          },
        })
      ) as typeof fetch;

    const result = await lookupMasumiInboxAgentForSession({
      session: testSession(),
      slug: 'direct-agent',
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.state).toBe('RegistrationConfirmed');
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('refreshes stale pending registration state from the registry', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-123',
              name: 'Verified Agent',
              description: null,
              agentSlug: 'verified-agent',
              linkedEmail: null,
              status: 'Verified',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:00:00.000Z',
              statusUpdatedAt: '2026-04-15T10:05:00.000Z',
              agentIdentifier: 'did:masumi:verified-agent',
            },
          ],
        },
      })
    ) as typeof fetch;

    const subject: SerializedMasumiActorRegistrationSubject = {
      slug: 'verified-agent',
      displayName: 'Verified Agent',
      registration: serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:verified-agent',
        masumiRegistrationState: 'RegistrationRequested',
      }),
    };

    const result = await syncMasumiInboxAgentRegistrationForSession({
      session: {
        authenticated: true,
        idToken: 'id-token',
        accessToken: 'access-token',
        grantedScopes: ['openid', 'profile', 'email'],
        expiresAt: '2026-04-16T00:00:00.000Z',
        user: {
          issuer: 'https://issuer.example.com',
          subject: 'user-123',
          audience: ['masumi-agent-messenger'],
          email: 'agent@example.com',
          emailVerified: true,
          name: 'Verified Agent',
        },
      },
      subject,
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.registrationState).toBe('RegistrationConfirmed');
    expect(result.registration.error).toBeNull();
    expect(result.metadata).toEqual(
      serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:verified-agent',
        masumiRegistrationState: 'RegistrationConfirmed',
      })
    );
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
      `https://issuer.example.com/registry/api/v1/inbox-agent-registration?network=${configuredNetwork}`
    );
  });

  it('preserves cached registration state when registry refresh fails', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('registry offline')) as typeof fetch;

    const subject: SerializedMasumiActorRegistrationSubject = {
      slug: 'pending-agent',
      displayName: 'Pending Agent',
      registration: serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-456',
        masumiAgentIdentifier: 'did:masumi:pending-agent',
        masumiRegistrationState: 'RegistrationRequested',
      }),
    };

    const result = await syncMasumiInboxAgentRegistrationForSession({
      session: {
        authenticated: true,
        idToken: 'id-token',
        accessToken: 'access-token',
        grantedScopes: ['openid', 'profile', 'email'],
        expiresAt: '2026-04-16T00:00:00.000Z',
        user: {
          issuer: 'https://issuer.example.com',
          subject: 'user-123',
          audience: ['masumi-agent-messenger'],
          email: 'agent@example.com',
          emailVerified: true,
          name: 'Pending Agent',
        },
      },
      subject,
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.registrationState).toBe('RegistrationRequested');
    expect(result.registration.error).toBe('registry offline');
    expect(result.metadata).toEqual(subject.registration);
  });

  it('refreshes pending deregistration state from the registry', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-789',
              name: 'Deregistered Agent',
              description: null,
              agentSlug: 'deregistered-agent',
              linkedEmail: null,
              status: 'Deregistered',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:15:00.000Z',
              statusUpdatedAt: '2026-04-15T10:15:00.000Z',
              agentIdentifier: 'did:masumi:deregistered-agent',
            },
          ],
        },
      })
    ) as typeof fetch;

    const result = await syncMasumiInboxAgentRegistrationForSession({
      session: testSession(),
      subject: {
        slug: 'deregistered-agent',
        displayName: 'Deregistered Agent',
        registration: serializeMasumiRegistrationMetadata({
          masumiRegistrationNetwork: configuredNetwork,
          masumiInboxAgentId: 'agent-789',
          masumiAgentIdentifier: 'did:masumi:deregistered-agent',
          masumiRegistrationState: 'DeregistrationRequested',
        }),
      },
    });

    expect(result.registration.status).toBe('deregistered');
    expect(result.registration.registrationState).toBe('DeregistrationConfirmed');
    expect(result.metadata).toEqual(
      serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:deregistered-agent',
        masumiRegistrationState: 'DeregistrationConfirmed',
      })
    );
  });

  it('uses verified registry state over cached pending deregistration', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-789',
              name: 'Registered Agent',
              description: null,
              agentSlug: 'registered-agent',
              linkedEmail: null,
              status: 'Verified',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:15:00.000Z',
              statusUpdatedAt: '2026-04-15T10:15:00.000Z',
              agentIdentifier: 'did:masumi:registered-agent',
            },
          ],
        },
      })
    ) as typeof fetch;

    const result = await syncMasumiInboxAgentRegistrationForSession({
      session: testSession(),
      subject: {
        slug: 'registered-agent',
        displayName: 'Registered Agent',
        registration: serializeMasumiRegistrationMetadata({
          masumiRegistrationNetwork: configuredNetwork,
          masumiInboxAgentId: 'agent-789',
          masumiAgentIdentifier: 'did:masumi:registered-agent',
          masumiRegistrationState: 'DeregistrationRequested',
        }),
      },
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.registrationState).toBe('RegistrationConfirmed');
    expect(result.metadata).toEqual(
      serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:registered-agent',
        masumiRegistrationState: 'RegistrationConfirmed',
      })
    );
  });

  it('refreshes invalid registry state over cached pending deregistration', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'success',
        data: {
          registrations: [
            {
              id: 'agent-789',
              name: 'Deregistered Agent',
              description: null,
              agentSlug: 'deregistered-agent',
              linkedEmail: null,
              status: 'Invalid',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:15:00.000Z',
              statusUpdatedAt: '2026-04-15T10:15:00.000Z',
              agentIdentifier: 'did:masumi:deregistered-agent',
            },
          ],
        },
      })
    ) as typeof fetch;

    const result = await syncMasumiInboxAgentRegistrationForSession({
      session: testSession(),
      subject: {
        slug: 'deregistered-agent',
        displayName: 'Deregistered Agent',
        registration: serializeMasumiRegistrationMetadata({
          masumiRegistrationNetwork: configuredNetwork,
          masumiInboxAgentId: 'agent-789',
          masumiAgentIdentifier: 'did:masumi:deregistered-agent',
          masumiRegistrationState: 'DeregistrationRequested',
        }),
      },
    });

    expect(result.registration.status).toBe('failed');
    expect(result.registration.registrationState).toBe('RegistrationFailed');
    expect(result.metadata).toEqual(
      serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:deregistered-agent',
        masumiRegistrationState: 'RegistrationFailed',
      })
    );
  });
});

describe('Masumi inbox-agent deregistration', () => {
  it('calls the SaaS deregister endpoint and returns updated metadata', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        // First call: authenticated Pay list so the server resolves the
        // Pay inboxAgentId accepted by /deregister rather than using the
        // public registry id or client-supplied registration metadata.
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'agent-123',
              name: 'Verified Agent',
              description: null,
              agentSlug: 'verified-agent',
              state: 'RegistrationConfirmed',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:00:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: 'did:masumi:verified-agent',
              metadataVersion: 1,
              sendFundingLovelace: null,
              SmartContractWallet: {
                walletVkey: 'vkey',
                walletAddress: 'addr',
              },
              RecipientWallet: null,
              CurrentTransaction: null,
            },
          ],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'agent-123',
            name: 'Verified Agent',
            description: null,
            agentSlug: 'verified-agent',
            state: 'DeregistrationRequested',
            createdAt: '2026-04-15T10:00:00.000Z',
            updatedAt: '2026-04-15T10:10:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: 'did:masumi:verified-agent',
          },
        })
      ) as typeof fetch;

    const result = await deregisterMasumiInboxAgentForSession({
      session: testSession(),
      subject: {
        slug: 'verified-agent',
        displayName: 'Verified Agent',
        registration: null,
      },
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.registrationState).toBe('DeregistrationRequested');
    expect(result.metadata).toEqual(
      serializeMasumiRegistrationMetadata({
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:verified-agent',
        masumiRegistrationState: 'DeregistrationRequested',
      })
    );
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}&take=20&search=verified-agent&filterStatus=Registered`
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents/agent-123/deregister?network=${configuredNetwork}`
    );
    expect(vi.mocked(global.fetch).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('ignores client-supplied masumiInboxAgentId and resolves from slug', async () => {
    process.env.MASUMI_NETWORK = configuredNetwork;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'server-authoritative-id',
              name: 'Verified Agent',
              description: null,
              agentSlug: 'verified-agent',
              state: 'RegistrationConfirmed',
              createdAt: '2026-04-15T10:00:00.000Z',
              updatedAt: '2026-04-15T10:00:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: 'did:masumi:verified-agent',
              metadataVersion: 1,
              sendFundingLovelace: null,
              SmartContractWallet: {
                walletVkey: 'vkey',
                walletAddress: 'addr',
              },
              RecipientWallet: null,
              CurrentTransaction: null,
            },
          ],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'server-authoritative-id',
            name: 'Verified Agent',
            description: null,
            agentSlug: 'verified-agent',
            state: 'DeregistrationRequested',
            createdAt: '2026-04-15T10:00:00.000Z',
            updatedAt: '2026-04-15T10:10:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: 'did:masumi:verified-agent',
          },
        })
      ) as typeof fetch;

    await deregisterMasumiInboxAgentForSession({
      session: testSession(),
      subject: {
        slug: 'verified-agent',
        displayName: 'Verified Agent',
        // Attacker-controlled registration metadata — server must ignore it
        // and resolve the real inboxAgentId via the session's OIDC-authorized
        // Pay list.
        registration: serializeMasumiRegistrationMetadata({
          masumiRegistrationNetwork: configuredNetwork,
          masumiInboxAgentId: 'attacker-supplied-id',
          masumiAgentIdentifier: 'did:masumi:attacker',
          masumiRegistrationState: 'RegistrationConfirmed',
        }),
      },
    });

    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}&take=20&search=verified-agent&filterStatus=Registered`
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents/server-authoritative-id/deregister?network=${configuredNetwork}`
    );
  });
});
