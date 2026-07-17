import { describe, expect, it } from 'vitest';
import {
  getFollowUpSessionRefreshDelayMs,
  getSessionExpiryDelayMs,
  getSessionRefreshDelayMs,
  getSessionRefreshRetryDelayMs,
  shouldClearUnlockedSessionMaterial,
  type AuthenticatedBrowserSession,
  type BrowserAuthSession,
} from '@/lib/auth-session';

function buildSession(
  overrides: Partial<AuthenticatedBrowserSession['user']> = {}
): AuthenticatedBrowserSession {
  return {
    authenticated: true,
    idToken: 'id-token',
    grantedScopes: ['openid'],
    expiresAt: '2026-04-15T12:00:00.000Z',
    user: {
      issuer: 'https://issuer.example',
      subject: 'user-123',
      audience: ['masumi-spacetime-web'],
      email: 'agent@example.com',
      emailVerified: true,
      name: 'Agent Example',
      ...overrides,
    },
  };
}

describe('auth-session vault clearing', () => {
  it('keeps unlocked local material for token refreshes on the same identity', () => {
    const previousSession = buildSession();
    const nextSession: BrowserAuthSession = {
      ...buildSession(),
      idToken: 'refreshed-id-token',
      expiresAt: '2026-04-15T13:00:00.000Z',
    };

    expect(shouldClearUnlockedSessionMaterial(previousSession, nextSession)).toBe(false);
  });

  it('clears unlocked local material when auth becomes anonymous', () => {
    expect(
      shouldClearUnlockedSessionMaterial(buildSession(), { authenticated: false })
    ).toBe(true);
  });

  it('clears unlocked local material when the authenticated identity namespace changes', () => {
    expect(
      shouldClearUnlockedSessionMaterial(
        buildSession(),
        buildSession({ subject: 'user-456' })
      )
    ).toBe(true);
    expect(
      shouldClearUnlockedSessionMaterial(
        buildSession(),
        buildSession({ email: 'other@example.com' })
      )
    ).toBe(true);
    expect(
      shouldClearUnlockedSessionMaterial(
        buildSession(),
        buildSession({ issuer: 'https://other-issuer.example' })
      )
    ).toBe(true);
  });

  it('does not clear when there was no previously authenticated session', () => {
    expect(
      shouldClearUnlockedSessionMaterial(null, buildSession())
    ).toBe(false);
  });

  it('refreshes before expiry and expires stale browser sessions locally', () => {
    const now = new Date('2026-04-15T11:50:00.000Z').getTime();
    const session = buildSession();

    expect(getSessionRefreshDelayMs(session, now)).toBe(60_000);
    expect(
      getSessionRefreshDelayMs(session, new Date('2026-04-15T11:59:45.000Z').getTime())
    ).toBe(1_000);
    expect(getSessionExpiryDelayMs(session, now)).toBe(600_000);
    expect(
      getSessionExpiryDelayMs(session, new Date('2026-04-15T12:00:01.000Z').getTime())
    ).toBe(0);
    expect(
      getSessionExpiryDelayMs({
        ...session,
        expiresAt: 'not-a-date',
      })
    ).toBeNull();
  });

  it('keeps polling when the server returns the same valid token', () => {
    const now = new Date('2026-04-15T11:50:00.000Z').getTime();
    const session = buildSession();

    expect(getFollowUpSessionRefreshDelayMs(session, session, now)).toBe(60_000);
    expect(
      getFollowUpSessionRefreshDelayMs(
        session,
        {
          ...session,
          idToken: 'refreshed-id-token',
          expiresAt: '2026-04-15T13:00:00.000Z',
        },
        now
      )
    ).toBeNull();
    expect(
      getFollowUpSessionRefreshDelayMs(
        session,
        { authenticated: false },
        now
      )
    ).toBeNull();
  });

  it('retries transient refresh failures without crossing token expiry', () => {
    const session = buildSession();

    expect(
      getSessionRefreshRetryDelayMs(
        session,
        new Date('2026-04-15T11:59:45.000Z').getTime()
      )
    ).toBe(5_000);
    expect(
      getSessionRefreshRetryDelayMs(
        session,
        new Date('2026-04-15T11:59:59.900Z').getTime()
      )
    ).toBe(250);
    expect(
      getSessionRefreshRetryDelayMs(
        session,
        new Date('2026-04-15T12:00:01.000Z').getTime()
      )
    ).toBeNull();
  });
});
