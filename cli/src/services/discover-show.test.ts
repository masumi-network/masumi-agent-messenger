import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasumiInboxAgentEntry } from '../../../shared/inbox-agent-registration';
import { showDiscoveredAgent } from './discover';

const mocks = vi.hoisted(() => ({
  ensureAuthenticatedSession: vi.fn(),
  resolvePreferredAgentSlug: vi.fn(),
  findMasumiInboxAgents: vi.fn(),
  listMasumiInboxAgents: vi.fn(),
  lookupMasumiInboxAgentBySlug: vi.fn(),
  searchMasumiInboxAgents: vi.fn(),
  connectAuthenticated: vi.fn(),
  disconnectConnection: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('./agent-state', () => ({
  resolvePreferredAgentSlug: mocks.resolvePreferredAgentSlug,
}));

vi.mock('./masumi-inbox-agent', () => ({
  findMasumiInboxAgents: mocks.findMasumiInboxAgents,
  listMasumiInboxAgents: mocks.listMasumiInboxAgents,
  lookupMasumiInboxAgentBySlug: mocks.lookupMasumiInboxAgentBySlug,
  searchMasumiInboxAgents: mocks.searchMasumiInboxAgents,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
}));

const reporter = {
  info: vi.fn(),
  success: vi.fn(),
  verbose: vi.fn(),
};

function registryEntry(overrides: Partial<MasumiInboxAgentEntry> = {}): MasumiInboxAgentEntry {
  return {
    id: overrides.id ?? 'registry-1',
    name: overrides.name ?? 'Space Agent',
    description: overrides.description ?? 'registry description should not render',
    agentSlug: overrides.agentSlug ?? 'space-agent',
    linkedEmail: overrides.linkedEmail ?? 'space@example.com',
    state: overrides.state ?? 'RegistrationConfirmed',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    lastCheckedAt: overrides.lastCheckedAt ?? null,
    agentIdentifier: overrides.agentIdentifier ?? 'registry-agent-id',
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.resolvePreferredAgentSlug.mockResolvedValue('owner');
  mocks.ensureAuthenticatedSession.mockResolvedValue({
    profile: {
      name: 'default',
      issuer: 'https://issuer.example',
      spacetimeHost: 'http://localhost:3000',
      spacetimeDbName: 'agentmessenger-dev',
    },
    session: {
      idToken: 'id-token',
    },
    claims: {},
  });
});

describe('showDiscoveredAgent', () => {
  it('throws a connectivity error when DB enrichment is unavailable', async () => {
    mocks.lookupMasumiInboxAgentBySlug.mockResolvedValue(registryEntry());
    mocks.connectAuthenticated.mockRejectedValue(new Error('db unavailable'));

    await expect(
      showDiscoveredAgent({
        profileName: 'default',
        reporter,
        identifier: 'space-agent',
      })
    ).rejects.toMatchObject({ code: 'DISCOVER_SHOW_FAILED' });
  });

  it('keeps actor enrichment when only the public route lookup fails', async () => {
    const conn = {
      procedures: {
        lookupPublishedAgentBySlug: vi.fn().mockResolvedValue([
          {
            slug: 'space-agent',
            publicIdentity: 'did:key:space-agent',
            isDefault: true,
            displayName: 'Spacetime Space Agent',
            agentIdentifier: 'spacetime-agent-id',
            encryptionKeyVersion: 'enc-v1',
            encryptionAlgorithm: 'x25519-xsalsa20-poly1305',
            encryptionPublicKey: 'enc-public',
            signingKeyVersion: 'sig-v1',
            signingAlgorithm: 'ed25519',
            signingPublicKey: 'sig-public',
          },
        ]),
        lookupPublishedPublicRouteBySlug: vi.fn().mockRejectedValue(new Error('route unavailable')),
      },
    };
    mocks.lookupMasumiInboxAgentBySlug.mockResolvedValue(registryEntry());
    mocks.connectAuthenticated.mockResolvedValue({ conn });

    const result = await showDiscoveredAgent({
      profileName: 'default',
      reporter,
      identifier: 'space-agent',
    });

    expect(result.selected).toEqual(
      expect.objectContaining({
        description: null,
        displayName: 'Spacetime Space Agent',
        publicIdentity: 'did:key:space-agent',
        encryptionKeyVersion: 'enc-v1',
        signingKeyVersion: 'sig-v1',
      })
    );
    expect(result.publicRoute).toBeNull();
    expect(mocks.disconnectConnection).toHaveBeenCalledWith(conn);
  });
});
