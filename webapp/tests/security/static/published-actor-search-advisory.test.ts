import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookupMasumiInboxAgent = vi.fn();
const mockFindMasumiInboxAgents = vi.fn();
const mockListMasumiInboxAgents = vi.fn();

vi.mock('../../../src/lib/inbox-agent-registration', () => ({
  lookupMasumiInboxAgent: mockLookupMasumiInboxAgent,
  findMasumiInboxAgents: mockFindMasumiInboxAgents,
  listMasumiInboxAgents: mockListMasumiInboxAgents,
}));

import { assertMasumiNetworkAgentCanReceiveChats } from '../../../src/lib/published-actor-search';

const SESSION = {
  authenticated: true as const,
  idToken: 'id-token',
  grantedScopes: ['openid'],
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    issuer: 'https://issuer.example',
    subject: 'subject-1',
    audience: ['masumi-spacetime-web'],
    email: 'owner@example.com',
    emailVerified: true,
  },
};

// `DbConnection` is type-only in the production module and the advisory path is
// hit BEFORE any connection-bound call would run (the registry lookup is what
// throws). A bare object cast satisfies the static type without requiring a
// real connection in this node-env test.
const STUB_CONNECTION = {} as Parameters<typeof assertMasumiNetworkAgentCanReceiveChats>[0]['liveConnection'];

describe('published-actor-search — advisory registry lookup', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLookupMasumiInboxAgent.mockReset();
    mockFindMasumiInboxAgents.mockReset();
    mockListMasumiInboxAgents.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT throw when the Masumi registry lookup fails — registry is advisory', async () => {
    mockLookupMasumiInboxAgent.mockRejectedValueOnce(new Error('Network unreachable'));

    await expect(
      assertMasumiNetworkAgentCanReceiveChats({
        slug: 'peer-slug',
        session: SESSION,
        liveConnection: STUB_CONNECTION,
      })
    ).resolves.toBeUndefined();
  });

  it('surfaces the registry failure via console.warn so it is not invisible', async () => {
    mockLookupMasumiInboxAgent.mockRejectedValueOnce(new Error('Registry 503'));

    await assertMasumiNetworkAgentCanReceiveChats({
      slug: 'peer-slug',
      session: SESSION,
      liveConnection: STUB_CONNECTION,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Masumi inbox-agent chat-state lookup failed',
      expect.objectContaining({
        slug: 'peer-slug',
        error: 'Registry 503',
      })
    );
  });

  it('treats a missing session as advisory pass-through (no registry call attempted)', async () => {
    await assertMasumiNetworkAgentCanReceiveChats({
      slug: 'peer-slug',
      session: null,
      liveConnection: STUB_CONNECTION,
    });

    expect(mockLookupMasumiInboxAgent).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
