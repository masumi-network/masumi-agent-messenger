import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import {
  type DbConnection,
} from '../../../webapp/src/module_bindings';
import {
  createRegistrationFailedMetadata,
  createRegistrationRequestedMetadata,
  getMasumiInboxAgentNetwork,
  registrationResultFromMetadata,
} from '../../../shared/inbox-agent-registration';
import type { Agent } from '../../../webapp/src/module_bindings/types';
import {
  applyRegistrationMetadataToActor,
  deregisterMasumiInboxAgentRegistration,
  findMasumiInboxAgents,
  importOwnedSaasInboxAgents,
  listMasumiInboxAgents,
  lookupMasumiInboxAgentBySlug,
  syncMasumiInboxAgentRegistration,
} from './masumi-inbox-agent';
import { getOrCreateStoredActorKeyPair } from './actor-keys';
import type { ResolvedProfile } from './config-store';
import type { StoredOidcSession } from './oidc';
import { readAccounts } from './spacetimedb';

vi.mock('./actor-keys', () => ({
  getOrCreateStoredActorKeyPair: vi.fn(),
}));

vi.mock('./spacetimedb', () => ({
  readAccounts: vi.fn(),
}));

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

function actor(
  row: Omit<
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
    | 'masumiRegistrationState'
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

const importProfile: ResolvedProfile = {
  name: 'default',
  issuer: 'https://issuer.example.com',
  clientId: 'client-id',
  redirectUri: 'http://localhost/callback',
  oidcScope: 'openid email',
  spacetimeHost: 'ws://spacetime.example.com',
  spacetimeDbName: 'masumi-agent-messenger',
};

const importSession: StoredOidcSession = {
  idToken: 'id-token',
  accessToken: 'access-token',
  expiresAt: 1,
  createdAt: 1,
};

const importReporter = () => ({
  info: vi.fn(),
  success: vi.fn(),
});

function createImportConn(params?: {
  createAgent?: () => Promise<void>;
  upsertMasumiRegistration?: () => Promise<void>;
  updateAgentProfile?: () => Promise<void>;
}): DbConnection {
  return {
    reducers: {
      createAgent: vi.fn(params?.createAgent ?? (async () => {})),
      upsertMasumiRegistration: vi.fn(
        params?.upsertMasumiRegistration ?? (async () => {})
      ),
      updateAgentProfile: vi.fn(params?.updateAgentProfile ?? (async () => {})),
    },
  } as unknown as DbConnection;
}

function ownedPayAgentRecord(overrides: Partial<{
  id: string;
  name: string;
  description: string | null;
  agentSlug: string;
  state: string;
  agentIdentifier: string | null;
}> = {}) {
  return {
    id: overrides.id ?? 'pay-agent-1',
    name: overrides.name ?? 'SaaS Bot',
    description: overrides.description ?? 'Imported from SaaS',
    agentSlug: overrides.agentSlug ?? 'saas-bot',
    state: overrides.state ?? 'RegistrationConfirmed',
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    lastCheckedAt: '2026-04-14T00:00:00.000Z',
    agentIdentifier: overrides.agentIdentifier ?? 'did:masumi:saas-bot',
  };
}

function mockOwnedAgentImportFetch(records: unknown[]): void {
  global.fetch = vi.fn(async input => {
    const url = new URL(String(input));
    const filterStatus = url.searchParams.get('filterStatus');
    return jsonResponse(200, {
      success: true,
      data: filterStatus === 'Registered' ? records : [],
      nextCursor: null,
    });
  }) as typeof fetch;
}

describe('applyRegistrationMetadataToActor', () => {
  it('applies registration metadata after syncing registration state', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 1n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'agent',
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        currentKeyBundleVersion: 1,
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
    expect(result.masumiRegistrationState).toEqual({ tag: 'Registered' });
  });

  it('applies registration metadata to non-default inbox actors too', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 2n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'planner-bot',
        isDefault: false,
        publicIdentity: 'planner-bot',
        displayName: 'Planner Bot',
        currentKeyBundleVersion: 1,
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
    expect(result.masumiRegistrationState).toEqual({ tag: 'Registered' });
  });

  it('preserves linked email visibility while applying registration metadata', () => {
    const result = applyRegistrationMetadataToActor(
      actor({
        id: 3n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'agent',
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        publicLinkedEmailEnabled: true,
        currentKeyBundleVersion: 1,
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
    expect(
      registrationResultFromMetadata({
        masumiRegistrationState: 'DeregistrationConfirmed',
      }).status
    ).toBe('deregistered');
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

describe('importOwnedSaasInboxAgents', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.mocked(readAccounts).mockReset();
    vi.mocked(getOrCreateStoredActorKeyPair).mockReset();
    vi.restoreAllMocks();
  });

  it('imports missing SaaS inbox agents into the local account', async () => {
    const defaultActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const createdActor = actor({
      id: 2n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'saas-bot',
      isDefault: false,
      publicIdentity: 'saas-bot',
      displayName: 'SaaS Bot',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(2n),
      updatedAt: timestamp(2n),
    });
    vi.mocked(readAccounts)
      .mockResolvedValueOnce({ inboxes: [], actors: [defaultActor] })
      .mockResolvedValueOnce({ inboxes: [], actors: [defaultActor, createdActor] });
    vi.mocked(getOrCreateStoredActorKeyPair).mockResolvedValue({
      encryption: {
        publicKey: 'enc-public',
        privateKey: 'enc-private',
        keyVersion: 1,
        algorithm: 'ECDH-P256',
      },
      signing: {
        publicKey: 'sig-public',
        privateKey: 'sig-private',
        keyVersion: 1,
        algorithm: 'ECDSA-P256-SHA256',
      },
    });
    mockOwnedAgentImportFetch([ownedPayAgentRecord()]);

    const conn = createImportConn();
    const reporter = importReporter();
    const summary = await importOwnedSaasInboxAgents({
      profile: importProfile,
      session: importSession,
      conn,
      email: 'agent@example.com',
      reporter,
      secretStore: {} as never,
      apply: true,
    });

    expect(summary.imported).toBe(1);
    expect(summary.warnings).toEqual([]);
    expect(conn.reducers.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'saas-bot',
        displayName: 'SaaS Bot',
        encryptionPublicKey: 'enc-public',
        signingPublicKey: 'sig-public',
        keyBundleVersion: 1,
      })
    );
    expect(conn.reducers.upsertMasumiRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 2n,
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'pay-agent-1',
        masumiAgentIdentifier: 'did:masumi:saas-bot',
        masumiRegistrationState: { tag: 'Registered' },
      })
    );
    expect(conn.reducers.updateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 2n,
        publicDescription: 'Imported from SaaS',
      })
    );
    expect(reporter.success).toHaveBeenCalledWith(
      'Imported managed SaaS agent saas-bot.'
    );
    const filterStatuses = vi
      .mocked(global.fetch)
      .mock.calls.map(call => new URL(String(call[0])).searchParams.get('filterStatus'));
    expect(filterStatuses).toEqual(['Registered', 'Pending']);
  });

  it('reports missing SaaS agents without creating them during doctor checks', async () => {
    const defaultActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    vi.mocked(readAccounts).mockResolvedValue({
      inboxes: [],
      actors: [defaultActor],
    });
    mockOwnedAgentImportFetch([ownedPayAgentRecord()]);

    const conn = createImportConn();
    const summary = await importOwnedSaasInboxAgents({
      profile: importProfile,
      session: importSession,
      conn,
      email: 'agent@example.com',
      reporter: importReporter(),
      apply: false,
    });

    expect(summary.checked).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.warnings).toEqual([
      'Managed SaaS agent saas-bot exists in SaaS but is missing locally.',
    ]);
    expect(conn.reducers.createAgent).not.toHaveBeenCalled();
    expect(getOrCreateStoredActorKeyPair).not.toHaveBeenCalled();
  });

  it('warns instead of failing when an imported slug is already used locally', async () => {
    const defaultActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    vi.mocked(readAccounts).mockResolvedValue({
      inboxes: [],
      actors: [defaultActor],
    });
    vi.mocked(getOrCreateStoredActorKeyPair).mockResolvedValue({
      encryption: {
        publicKey: 'enc-public',
        privateKey: 'enc-private',
        keyVersion: 1,
        algorithm: 'ECDH-P256',
      },
      signing: {
        publicKey: 'sig-public',
        privateKey: 'sig-private',
        keyVersion: 1,
        algorithm: 'ECDSA-P256-SHA256',
      },
    });
    mockOwnedAgentImportFetch([ownedPayAgentRecord()]);

    const conn = createImportConn({
      createAgent: async () => {
        throw new Error('Inbox slug is already in use on this network');
      },
    });
    const reporter = importReporter();
    const summary = await importOwnedSaasInboxAgents({
      profile: importProfile,
      session: importSession,
      conn,
      email: 'agent@example.com',
      reporter,
      secretStore: {} as never,
      apply: true,
    });

    expect(summary.imported).toBe(0);
    expect(summary.warnings).toEqual([
      'Managed SaaS agent saas-bot was not imported: slug is already in use locally.',
    ]);
    expect(reporter.info).toHaveBeenCalledWith(
      'Warning: Managed SaaS agent saas-bot was not imported: slug is already in use locally.'
    );
  });
});

describe('findMasumiInboxAgents', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.useRealTimers();
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
    vi.useRealTimers();
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
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refreshes stale pending state from the registry even when an agent identifier exists', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'skip',
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.inboxAgentId).toBe('agent-123');
    expect(result.registration.agentIdentifier).toBe('did:masumi:agent');
    expect(result.registration.registrationState).toBe('RegistrationConfirmed');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:agent',
      masumiRegistrationState: { tag: 'Registered' },
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
          upsertMasumiRegistration: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiInboxAgentId: 'agent-123',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'skip',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('agent-123');
    expect(result.registration.agentIdentifier).toBe('did:masumi:agent');
    expect(result.registration.registrationState).toBe('RegistrationRequested');
    expect(result.registration.error).toBe('registry offline');
  });

  it('refreshes pending deregistration state from the registry', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
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
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-15T00:15:00.000Z',
              statusUpdatedAt: '2026-04-15T00:15:00.000Z',
              agentIdentifier: 'did:masumi:deregistered-agent',
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'deregistered-agent',
          isDefault: true,
          publicIdentity: 'deregistered-agent',
          displayName: 'Deregistered Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:deregistered-agent',
        masumiRegistrationState: { tag: 'PendingDeregistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'skip',
    });

    expect(result.registration.status).toBe('deregistered');
    expect(result.registration.registrationState).toBe('DeregistrationConfirmed');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-789',
      masumiAgentIdentifier: 'did:masumi:deregistered-agent',
      masumiRegistrationState: { tag: 'Deregistered' },
    });
  });

  it('uses verified registry state over cached pending deregistration', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
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
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-15T00:15:00.000Z',
              statusUpdatedAt: '2026-04-15T00:15:00.000Z',
              agentIdentifier: 'did:masumi:registered-agent',
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'registered-agent',
          isDefault: true,
          publicIdentity: 'registered-agent',
          displayName: 'Registered Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:registered-agent',
        masumiRegistrationState: { tag: 'PendingDeregistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'skip',
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.registrationState).toBe('RegistrationConfirmed');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-789',
      masumiAgentIdentifier: 'did:masumi:registered-agent',
      masumiRegistrationState: { tag: 'Registered' },
    });
  });

  it('refreshes invalid registry state over cached pending deregistration', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
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
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-15T00:15:00.000Z',
              statusUpdatedAt: '2026-04-15T00:15:00.000Z',
              agentIdentifier: 'did:masumi:deregistered-agent',
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'deregistered-agent',
          isDefault: true,
          publicIdentity: 'deregistered-agent',
          displayName: 'Deregistered Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'agent-789',
        masumiAgentIdentifier: 'did:masumi:deregistered-agent',
        masumiRegistrationState: { tag: 'PendingDeregistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'skip',
    });

    expect(result.registration.status).toBe('failed');
    expect(result.registration.registrationState).toBe('RegistrationFailed');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-789',
      masumiAgentIdentifier: 'did:masumi:deregistered-agent',
      masumiRegistrationState: { tag: 'Failed' },
    });
  });

  it('creates a fresh SaaS item in auto mode when stale local pending state has no owned item', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'fresh-agent-id',
            name: 'Agent',
            description: null,
            agentSlug: 'agent',
            state: 'RegistrationRequested',
            createdAt: '2026-04-15T00:20:00.000Z',
            updatedAt: '2026-04-15T00:20:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: null,
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
          upsertMasumiRegistration,
          updateAgentProfile: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: 'did:masumi:old-agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('fresh-agent-id');
    expect(result.registration.agentIdentifier).toBe('did:masumi:old-agent');
    expect(upsertMasumiRegistration).toHaveBeenLastCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'fresh-agent-id',
      masumiAgentIdentifier: 'did:masumi:old-agent',
      masumiRegistrationState: { tag: 'PendingRegistration' },
    });
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}&take=20&search=agent&filterStatus=Registered`
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}&take=20&search=agent&filterStatus=Pending`
    );
    expect(String(vi.mocked(global.fetch).mock.calls[3]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}`
    );
  });

  it('creates a fresh SaaS item in auto mode when stale local pending state still has an old inboxAgentId', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'fresh-agent-id',
            name: 'Agent',
            description: null,
            agentSlug: 'agent',
            state: 'RegistrationRequested',
            createdAt: '2026-04-15T00:20:00.000Z',
            updatedAt: '2026-04-15T00:20:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: null,
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
          upsertMasumiRegistration,
          updateAgentProfile: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'stale-agent-id',
        masumiAgentIdentifier: 'did:masumi:old-agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('fresh-agent-id');
    expect(result.registration.agentIdentifier).toBe('did:masumi:old-agent');
    expect(upsertMasumiRegistration).toHaveBeenLastCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'fresh-agent-id',
      masumiAgentIdentifier: 'did:masumi:old-agent',
      masumiRegistrationState: { tag: 'PendingRegistration' },
    });
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(4);
  });

  it('does not create a duplicate when auto mode finds an owned pending SaaS item', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'existing-pending-id',
              name: 'Agent',
              description: null,
              agentSlug: 'agent',
              state: 'RegistrationRequested',
              createdAt: '2026-04-15T00:20:00.000Z',
              updatedAt: '2026-04-15T00:20:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: null,
            },
          ],
          nextCursor: null,
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: 'did:masumi:old-agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('existing-pending-id');
    expect(result.registration.agentIdentifier).toBe('did:masumi:old-agent');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'existing-pending-id',
      masumiAgentIdentifier: 'did:masumi:old-agent',
      masumiRegistrationState: { tag: 'PendingRegistration' },
    });
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toContain(
      'filterStatus=Registered'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toContain(
      'filterStatus=Pending'
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('keeps a trusted confirmed local registration when owned Pay lookup returns no exact item', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'confirmed-agent-id',
        masumiAgentIdentifier: 'did:masumi:confirmed-agent',
        masumiRegistrationState: { tag: 'Registered' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.inboxAgentId).toBe('confirmed-agent-id');
    expect(result.registration.agentIdentifier).toBe('did:masumi:confirmed-agent');
    expect(upsertMasumiRegistration).not.toHaveBeenCalled();
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toContain(
      'filterStatus=Registered'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toContain(
      'filterStatus=Pending'
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('paginates the owned Pay lookup until it finds an exact slug match in auto mode', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'other-agent-id',
              name: 'Other Agent',
              description: null,
              agentSlug: 'other-agent',
              state: 'RegistrationConfirmed',
              createdAt: '2026-04-15T00:10:00.000Z',
              updatedAt: '2026-04-15T00:10:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: null,
            },
          ],
          nextCursor: 'cursor-2',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'existing-pending-id',
              name: 'Agent',
              description: null,
              agentSlug: 'agent',
              state: 'RegistrationRequested',
              createdAt: '2026-04-15T00:20:00.000Z',
              updatedAt: '2026-04-15T00:20:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: null,
            },
          ],
          nextCursor: null,
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: 'did:masumi:old-agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('existing-pending-id');
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toContain(
      'filterStatus=Registered'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[2]?.[0])).toContain(
      'filterStatus=Pending'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[2]?.[0])).toContain('cursor=cursor-2');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'existing-pending-id',
      masumiAgentIdentifier: 'did:masumi:old-agent',
      masumiRegistrationState: { tag: 'PendingRegistration' },
    });
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(3);
  });

  it('falls back to the pending pass when the registered pass has no exact match in auto mode', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'older-pending-id',
              name: 'Agent',
              description: null,
              agentSlug: 'agent',
              state: 'RegistrationRequested',
              createdAt: '2026-04-15T00:20:00.000Z',
              updatedAt: '2026-04-15T00:20:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: null,
            },
          ],
          nextCursor: null,
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: 'did:masumi:old-agent',
        masumiRegistrationState: { tag: 'PendingRegistration' },
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('older-pending-id');
    expect(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).toContain(
      'filterStatus=Registered'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toContain(
      'filterStatus=Pending'
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(2);
  });

  it('surfaces SaaS slug conflicts in auto mode registration attempts', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          success: false,
          error: 'Inbox slug is already in use on this network',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
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
          upsertMasumiRegistration,
          updateAgentProfile: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: undefined,
        masumiRegistrationState: undefined,
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('failed');
    expect(result.registration.error).toBe(
      'Inbox slug is already in use on this network'
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(6);
  });

  it('does not fail pending registration when an older reducer requires an agent identifier', async () => {
    const upsertMasumiRegistration = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'All four masumi_* fields must be Some together (register) or None together (clear)'
        )
      );
    const updateAgentProfile = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'pending-agent-id',
            name: 'Agent',
            description: null,
            agentSlug: 'agent',
            state: 'RegistrationRequested',
            createdAt: '2026-04-15T00:20:00.000Z',
            updatedAt: '2026-04-15T00:20:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: null,
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
          upsertMasumiRegistration,
          updateAgentProfile,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: actor({
        id: 1n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'agent',
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        currentKeyBundleVersion: 1,
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.inboxAgentId).toBe('pending-agent-id');
    expect(result.registration.agentIdentifier).toBeNull();
    expect(updateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 1n,
        publicLinkedEmailEnabled: true,
      })
    );
  });

  it('returns a retryable result when Masumi registration stalls', async () => {
    vi.useFakeTimers();
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    const updateAgentProfile = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
      ) as typeof fetch;

    const registration = syncMasumiInboxAgentRegistration({
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
          upsertMasumiRegistration,
          updateAgentProfile,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: actor({
        id: 1n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'agent',
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        currentKeyBundleVersion: 1,
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await registration;

    expect(result.registration.status).toBe('service_unavailable');
    expect(result.registration.error).toBe(
      'Masumi request timed out after 15 seconds.'
    );
    expect(upsertMasumiRegistration).not.toHaveBeenCalled();
  });

  it('reconciles SaaS slug conflicts when the existing inbox agent is owned by the account', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    const updateAgentProfile = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            creditsRemaining: 3,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          success: false,
          error: 'Inbox slug is already in use on this network',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'existing-owned-id',
              name: 'Agent',
              description: null,
              agentSlug: 'agent',
              state: 'RegistrationConfirmed',
              createdAt: '2026-04-15T00:20:00.000Z',
              updatedAt: '2026-04-15T00:20:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: 'did:masumi:agent',
            },
          ],
          nextCursor: null,
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
          upsertMasumiRegistration,
          updateAgentProfile,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: undefined,
        masumiRegistrationState: undefined,
      },
      reporter: {
        info() {},
        success() {},
      },
      mode: 'auto',
    });

    expect(result.registration.status).toBe('registered');
    expect(result.registration.inboxAgentId).toBe('existing-owned-id');
    expect(result.registration.agentIdentifier).toBe('did:masumi:agent');
    expect(result.registration.error).toBeNull();
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'existing-owned-id',
      masumiAgentIdentifier: 'did:masumi:agent',
      masumiRegistrationState: { tag: 'Registered' },
    });
    expect(updateAgentProfile).toHaveBeenCalledWith({
      agentDbId: 1n,
      displayName: undefined,
      publicDescription: undefined,
      publicLinkedEmailEnabled: true,
      allowAllMessageContentTypes: undefined,
      allowAllMessageHeaders: undefined,
      supportedMessageContentTypes: undefined,
      supportedMessageHeaderNames: undefined,
    });
    expect(String(vi.mocked(global.fetch).mock.calls[4]?.[0])).toContain(
      'search=agent'
    );
    expect(String(vi.mocked(global.fetch).mock.calls[5]?.[0])).not.toContain(
      'search='
    );
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(6);
  });
});

describe('deregisterMasumiInboxAgentRegistration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves the authoritative SaaS registration id before deregistering', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [
            {
              id: 'agent-123',
              name: 'Agent',
              description: 'Registered agent',
              agentSlug: 'agent',
              state: 'RegistrationConfirmed',
              createdAt: '2026-04-15T00:00:00.000Z',
              updatedAt: '2026-04-15T00:00:00.000Z',
              lastCheckedAt: null,
              agentIdentifier: 'did:masumi:agent',
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
            name: 'Agent',
            description: 'Registered agent',
            agentSlug: 'agent',
            state: 'DeregistrationRequested',
            createdAt: '2026-04-15T00:00:00.000Z',
            updatedAt: '2026-04-15T00:10:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: 'did:masumi:agent',
          },
        })
      ) as typeof fetch;

    const result = await deregisterMasumiInboxAgentRegistration({
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: {
        ...actor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          isDefault: true,
          publicIdentity: 'agent',
          displayName: 'Agent',
          currentKeyBundleVersion: 1,
          createdAt: timestamp(1n),
          updatedAt: timestamp(1n),
        }),
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'stale-local-id',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: { tag: 'Registered' },
      },
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.registration.status).toBe('pending');
    expect(result.registration.registrationState).toBe('DeregistrationRequested');
    expect(upsertMasumiRegistration).toHaveBeenCalledWith({
      agentDbId: 1n,
      masumiRegistrationNetwork: configuredNetwork,
      masumiInboxAgentId: 'agent-123',
      masumiAgentIdentifier: 'did:masumi:agent',
      masumiRegistrationState: { tag: 'PendingDeregistration' },
    });

    const calls = vi.mocked(global.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents?network=${configuredNetwork}&take=20&search=agent`
    );
    expect(String(calls[1]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents/agent-123/deregister?network=${configuredNetwork}`
    );
    expect(calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      })
    );
    expect(calls).toHaveLength(2);
  });

  it('falls back to local confirmed id when owned Pay lookup returns no exact item', async () => {
    const upsertMasumiRegistration = vi.fn().mockResolvedValue(undefined);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: [],
          nextCursor: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: {
            id: 'local-confirmed-id',
            name: 'Agent',
            description: 'Registered agent',
            agentSlug: 'agent',
            state: 'DeregistrationRequested',
            createdAt: '2026-04-15T00:00:00.000Z',
            updatedAt: '2026-04-15T00:10:00.000Z',
            lastCheckedAt: null,
            agentIdentifier: 'did:masumi:agent',
          },
        })
      ) as typeof fetch;

    const result = await deregisterMasumiInboxAgentRegistration({
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
          upsertMasumiRegistration,
        },
      } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
      actor: actor({
        id: 1n,
        accountId: 10n,
        email: 'agent@example.com',
        slug: 'agent',
        isDefault: true,
        publicIdentity: 'agent',
        displayName: 'Agent',
        currentKeyBundleVersion: 1,
        masumiRegistrationNetwork: configuredNetwork,
        masumiInboxAgentId: 'local-confirmed-id',
        masumiAgentIdentifier: 'did:masumi:agent',
        masumiRegistrationState: 'RegistrationConfirmed',
        createdAt: timestamp(1n),
        updatedAt: timestamp(1n),
      }),
      reporter: {
        info() {},
        success() {},
      },
    });

    expect(result.registration.status).toBe('pending');
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toBe(
      `https://issuer.example.com/pay/api/v1/inbox-agents/local-confirmed-id/deregister?network=${configuredNetwork}`
    );
  });

  it('surfaces owned Pay lookup failures without treating the agent as unregistered', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(503, {
        success: false,
        error: 'pay offline',
      })
    ) as typeof fetch;

    await expect(
      deregisterMasumiInboxAgentRegistration({
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
            upsertMasumiRegistration: vi.fn().mockResolvedValue(undefined),
          },
        } as unknown as import('../../../webapp/src/module_bindings').DbConnection,
        actor: {
          ...actor({
            id: 1n,
            accountId: 10n,
            email: 'agent@example.com',
            slug: 'agent',
            isDefault: true,
            publicIdentity: 'agent',
            displayName: 'Agent',
            currentKeyBundleVersion: 1,
            createdAt: timestamp(1n),
            updatedAt: timestamp(1n),
          }),
          masumiRegistrationNetwork: configuredNetwork,
          masumiInboxAgentId: 'local-confirmed-id',
          masumiAgentIdentifier: 'did:masumi:agent',
          masumiRegistrationState: { tag: 'Registered' },
        },
        reporter: {
          info() {},
          success() {},
        },
      })
    ).rejects.toMatchObject({
      message: 'pay offline',
    });
  });
});
