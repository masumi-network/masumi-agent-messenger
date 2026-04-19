import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASUMI_DEFAULT_OIDC_ISSUER } from '../../../shared/masumi-default-oidc-issuer';
import { DEFAULT_MASUMI_OIDC_SCOPES } from '../../../shared/masumi-oidc-scopes';
import {
  decodeIdTokenClaims,
  getOidcScope,
  pollDeviceAuthorization,
  requestVerificationEmail,
  requestDeviceAuthorization,
  resolveBetterAuthBaseUrl,
  waitForDeviceAuthorization,
  type OidcMetadata,
} from './oidc';

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createTestIdToken(payload: Record<string, unknown>): string {
  return [
    base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    base64UrlEncode(JSON.stringify(payload)),
    '',
  ].join('.');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

const metadata: OidcMetadata = {
  issuer: MASUMI_DEFAULT_OIDC_ISSUER,
  authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
  token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
};

describe('resolveBetterAuthBaseUrl', () => {
  it('trims /oauth2/authorize from the discovered authorization endpoint', () => {
    expect(resolveBetterAuthBaseUrl(metadata)).toBe(`${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth`);
  });

  it('falls back to issuer/api/auth when the authorization endpoint is non-standard', () => {
    expect(
      resolveBetterAuthBaseUrl({
        issuer: MASUMI_DEFAULT_OIDC_ISSUER,
        authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/custom-authorize`,
      })
    ).toBe(`${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth`);
  });
});

describe('getOidcScope', () => {
  it('requests the full Masumi scope set and strips removed scopes', () => {
    const scopes = getOidcScope('agents:read:preprod account:read').split(' ');

    expect(scopes).toEqual(DEFAULT_MASUMI_OIDC_SCOPES);
    expect(scopes).toContain('inbox-agents:write:mainnet');
    expect(scopes).not.toContain('account:read');
  });
});

describe('decodeIdTokenClaims', () => {
  it('parses standard OIDC id_token claims', () => {
    const token = createTestIdToken({
      iss: MASUMI_DEFAULT_OIDC_ISSUER,
      sub: 'user-123',
      aud: ['masumi-spacetime-cli'],
      email: 'agent@example.com',
      email_verified: true,
      name: 'Agent',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const claims = decodeIdTokenClaims(token);

    expect(claims.issuer).toBe(MASUMI_DEFAULT_OIDC_ISSUER);
    expect(claims.subject).toBe('user-123');
    expect(claims.email).toBe('agent@example.com');
    expect(claims.emailVerified).toBe(true);
    expect(claims.audience).toEqual(['masumi-spacetime-cli']);
    expect(claims.name).toBe('Agent');
  });
});

describe('requestDeviceAuthorization', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, {
        device_code: 'device-123',
        user_code: 'ABCD-EFGH',
        verification_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/device`,
        verification_uri_complete: `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 1800,
        interval: 7,
      })
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts the expected Better Auth payload and normalizes the response', async () => {
    const challenge = await requestDeviceAuthorization({
      metadata,
      clientId: 'masumi-spacetime-cli',
      scope: 'openid profile email offline_access',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/device/code`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: 'masumi-spacetime-cli',
          scope: 'openid profile email offline_access',
        }),
      })
    );
    expect(challenge.deviceCode).toBe('device-123');
    expect(challenge.userCode).toBe('ABCD-EFGH');
    expect(challenge.verificationUri).toBe(`${MASUMI_DEFAULT_OIDC_ISSUER}/device`);
    expect(challenge.verificationUriComplete).toBe(
      `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`
    );
    expect(challenge.intervalSeconds).toBe(7);
  });
});

describe('requestVerificationEmail', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts the expected Better Auth payload', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, {
        status: true,
      })
    ) as typeof fetch;

    await requestVerificationEmail({
      metadata,
      email: 'agent@example.com',
      callbackURL: '/account',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/send-verification-email`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'agent@example.com',
          callbackURL: '/account',
        }),
      })
    );
  });
});

describe('pollDeviceAuthorization', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the OAuth token endpoint first in auto mode when both transports are available', async () => {
    const baMetadata: OidcMetadata = {
      ...metadata,
      device_authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/device/code`,
    };

    global.fetch = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        scope: 'openid profile email',
        id_token: createTestIdToken({
          iss: MASUMI_DEFAULT_OIDC_ISSUER,
          sub: 'user-123',
          aud: ['masumi-spacetime-cli'],
          email: 'agent@example.com',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      })
    ) as typeof fetch;

    const result = await pollDeviceAuthorization({
      metadata: baMetadata,
      clientId: 'masumi-spacetime-cli',
      deviceCode: 'device-xyz',
    });

    expect(result.kind).toBe('success');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    );
  });

  it('falls back to Better Auth /device/token when the OAuth token exchange fails after approval', async () => {
    const baMetadata: OidcMetadata = {
      ...metadata,
      device_authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/device/code`,
    };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: 'invalid_grant',
          error_description: 'Failed to exchange device token',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'openid profile email',
          id_token: createTestIdToken({
            iss: MASUMI_DEFAULT_OIDC_ISSUER,
            sub: 'user-123',
            aud: ['masumi-spacetime-cli'],
            email: 'agent@example.com',
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        })
      ) as typeof fetch;

    const debug = vi.fn();
    const result = await pollDeviceAuthorization({
      metadata: baMetadata,
      clientId: 'masumi-spacetime-cli',
      deviceCode: 'device-xyz',
      debug,
    });

    expect(result.kind).toBe('success');
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/device/token`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('retrying with better auth device token endpoint')
    );
  });

  it('surfaces email verification required instead of claiming the user denied access', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(403, {
        error: 'access_denied',
        error_description: 'email_verification_required',
      })
    ) as typeof fetch;

    await expect(
      pollDeviceAuthorization({
        metadata,
        clientId: 'masumi-spacetime-cli',
        deviceCode: 'device-xyz',
      })
    ).rejects.toThrow(
      'Device authorization failed: email verification required. Verify your email in Masumi SaaS and try again.'
    );
  });
});

describe('waitForDeviceAuthorization', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('keeps polling through pending and slow_down until it receives tokens', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, { error: 'authorization_pending' })
      )
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'openid profile email offline_access inbox-agents:read:preprod',
          id_token: createTestIdToken({
            iss: MASUMI_DEFAULT_OIDC_ISSUER,
            sub: 'user-123',
            aud: ['masumi-spacetime-cli'],
            email: 'agent@example.com',
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        })
      ) as typeof fetch;

    const waits: number[] = [];
    const session = await waitForDeviceAuthorization({
      metadata,
      clientId: 'masumi-spacetime-cli',
      deviceCode: 'device-123',
      intervalSeconds: 5,
      sleep: async ms => {
        waits.push(ms);
      },
    });

    expect(session.idToken).toContain('.');
    expect(session.refreshToken).toBe('refresh-token');
    expect(session.accessToken).toBe('access-token');
    expect(session.grantedScopes).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'inbox-agents:read:preprod',
    ]);
    expect(waits).toEqual([5000, 10000]);
  });

  it('fails clearly when the device flow returns no id_token', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      })
    ) as typeof fetch;

    await expect(
      waitForDeviceAuthorization({
        metadata,
        clientId: 'masumi-spacetime-cli',
        deviceCode: 'device-123',
        sleep: async () => {},
      })
    ).rejects.toThrow('Device authorization completed without an id_token.');
  });

  it('turns access_denied into a user-facing auth error', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(400, { error: 'access_denied' })
    ) as typeof fetch;

    await expect(
      waitForDeviceAuthorization({
        metadata,
        clientId: 'masumi-spacetime-cli',
        deviceCode: 'device-123',
        sleep: async () => {},
      })
    ).rejects.toThrow('Device authorization was denied by the user.');
  });

  it('turns expired_token into a re-login error', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(400, { error: 'expired_token' })
    ) as typeof fetch;

    await expect(
      waitForDeviceAuthorization({
        metadata,
        clientId: 'masumi-spacetime-cli',
        deviceCode: 'device-123',
        sleep: async () => {},
      })
    ).rejects.toThrow('The device authorization expired. Run `masumi-agent-messenger account login` again.');
  });
});
