import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OIDC_ISSUER as MASUMI_DEFAULT_OIDC_ISSUER } from './env';

vi.mock('./inbox-bootstrap', () => ({
  bootstrapAuthenticatedInbox: vi.fn(async (params: { profile: { name: string } }) => ({
    connected: true,
    bootstrapped: true,
    profile: params.profile.name,
    spacetimeIdentity: 'identity-123',
    inbox: {
      id: '42',
      normalizedEmail: 'agent@example.com',
      displayEmail: 'agent@example.com',
    },
    actor: {
      id: '7',
      slug: 'agent',
      publicIdentity: 'agent-public-identity',
      displayName: 'Agent',
    },
  })),
}));

import {
  authStatus,
  ensureAuthenticatedSession,
  isPendingDeviceLoginResult,
  login,
  requestVerificationEmailForIssuer,
  startLogin,
  waitForLogin,
} from './auth';
import type { SecretStore } from './secret-store';

let testSigningKeyPair: CryptoKeyPair;
let testPublicJwk: JsonWebKey & { alg: 'RS256'; kid: 'test-key'; use: 'sig' };

function base64UrlEncode(value: string | Uint8Array): string {
  const buffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return buffer
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

async function createSignedTestIdToken(payload: Record<string, unknown>): Promise<string> {
  const encodedHeader = base64UrlEncode(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })
  );
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    testSigningKeyPair.privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function fetchInputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockAuthIssuerFetch(params: {
  tokenResponse?: Response;
} = {}): void {
  const discoveryUrl = `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/openid-configuration`;
  const tokenEndpoint = `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`;
  const jwksUri = `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`;
  global.fetch = vi.fn(async input => {
    const url = fetchInputUrl(input);
    if (url === discoveryUrl) {
      return jsonResponse(200, {
        issuer: MASUMI_DEFAULT_OIDC_ISSUER,
        authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: jwksUri,
      });
    }
    if (url === jwksUri) {
      return jsonResponse(200, { keys: [testPublicJwk] });
    }
    if (url === tokenEndpoint && params.tokenResponse) {
      return params.tokenResponse;
    }
    throw new Error(`Unexpected auth issuer request to ${url}`);
  }) as typeof fetch;
}

function createReporter() {
  return {
    info: vi.fn(),
    success: vi.fn(),
  };
}

function createSecretStoreStub(): SecretStore {
  return {
    getOidcSession: vi.fn(async () => null),
    setOidcSession: vi.fn(async () => {}),
    deleteOidcSession: vi.fn(async () => true),
    getAgentKeyPair: vi.fn(async () => null),
    setAgentKeyPair: vi.fn(async () => {}),
    deleteAgentKeyPair: vi.fn(async () => true),
    getDeviceKeyMaterial: vi.fn(async () => null),
    setDeviceKeyMaterial: vi.fn(async () => {}),
    deleteDeviceKeyMaterial: vi.fn(async () => true),
    getNamespaceKeyVault: vi.fn(async () => null),
    setNamespaceKeyVault: vi.fn(async () => {}),
    deleteNamespaceKeyVault: vi.fn(async () => true),
  };
}

beforeAll(async () => {
  testSigningKeyPair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  testPublicJwk = {
    ...((await webcrypto.subtle.exportKey(
      'jwk',
      testSigningKeyPair.publicKey
    )) as JsonWebKey),
    alg: 'RS256',
    kid: 'test-key',
    use: 'sig',
  };
});

describe('auth service', () => {
  let tempDir: string;
  const originalFetch = global.fetch;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalOidcIssuer = process.env.MASUMI_OIDC_ISSUER;
  const originalOidcClientId = process.env.MASUMI_OIDC_CLIENT_ID;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-auth-'));
    process.env.XDG_CONFIG_HOME = tempDir;
    process.env.MASUMI_OIDC_ISSUER = MASUMI_DEFAULT_OIDC_ISSUER;
    process.env.MASUMI_OIDC_CLIENT_ID = 'masumi-spacetime-cli';
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    process.env.MASUMI_OIDC_ISSUER = originalOidcIssuer;
    process.env.MASUMI_OIDC_CLIENT_ID = originalOidcClientId;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the pending device challenge shape for start-only login', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer: MASUMI_DEFAULT_OIDC_ISSUER,
          authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: 'device-123',
          user_code: 'ABCD-EFGH',
          verification_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/device`,
          verification_uri_complete:
            `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 1800,
          interval: 7,
        })
      ) as typeof fetch;

    const reporter = createReporter();
    const result = await startLogin({
      profileName: 'default',
      reporter,
    });

    expect(isPendingDeviceLoginResult(result)).toBe(true);
    expect(result).toMatchObject({
      authenticated: false,
      pending: true,
      profile: 'default',
      issuer: MASUMI_DEFAULT_OIDC_ISSUER,
      clientId: 'masumi-spacetime-cli',
      deviceCode: 'ABCD-EFGH',
      pollingCode: 'device-123',
      verificationUri: `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
      intervalSeconds: 7,
    });
    expect(result).not.toHaveProperty('verificationUriComplete');
    expect(result.requestedScopes).toContain('inbox-agents:read:preprod');
    expect(result.requestedScopes).toContain('dashboard:read:mainnet');
  });

  it('builds one complete verification URI when the issuer omits the complete URI', async () => {
    const issuer = 'https://app.masumi.network';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer,
          authorization_endpoint: `${issuer}/api/auth/oauth2/authorize`,
          token_endpoint: `${issuer}/api/auth/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: 'device-app',
          user_code: 'XYCGQUPE',
          verification_uri: `${issuer}/device?network=mainnet`,
          expires_in: 1800,
          interval: 5,
        })
      ) as typeof fetch;

    const reporter = createReporter();
    const result = await startLogin({
      profileName: 'default',
      issuer,
      reporter,
    });

    expect(result.verificationUri).toBe(
      'https://app.masumi.network/device?network=mainnet&user_code=XYCGQUPE'
    );
    expect(result).not.toHaveProperty('verificationUriComplete');
  });

  it('emits auth debug steps when debug mode is enabled', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer: MASUMI_DEFAULT_OIDC_ISSUER,
          authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`,
          device_authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/device/code`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: 'device-123',
          user_code: 'ABCD-EFGH',
          verification_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/device`,
          verification_uri_complete:
            `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 1800,
          interval: 7,
        })
      ) as typeof fetch;

    const reporter = createReporter();
    await startLogin({
      profileName: 'default',
      reporter,
      debug: true,
    });

    expect(reporter.info).toHaveBeenCalledWith(
      expect.stringContaining('[auth debug]')
    );
    expect(reporter.info).toHaveBeenCalledWith(
      expect.stringContaining('Token endpoint:')
    );
    expect(reporter.info).toHaveBeenCalledWith(
      expect.stringContaining('Device authorization created:')
    );
  });

  it('requests a verification email through the issuer endpoint', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer: MASUMI_DEFAULT_OIDC_ISSUER,
          authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: true,
        })
      ) as typeof fetch;

    const reporter = createReporter();
    const result = await requestVerificationEmailForIssuer({
      profileName: 'default',
      email: 'agent@example.com',
      callbackURL: '/account',
      reporter,
    });

    expect(result).toMatchObject({
      sent: true,
      email: 'agent@example.com',
      issuer: MASUMI_DEFAULT_OIDC_ISSUER,
      callbackURL: '/account',
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
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

  it('waits for enter before opening the browser in interactive login', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer: MASUMI_DEFAULT_OIDC_ISSUER,
          authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: 'device-123',
          user_code: 'ABCD-EFGH',
          verification_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/device`,
          verification_uri_complete:
            `${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 1800,
          interval: 5,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'openid profile email offline_access inbox-agents:read:preprod',
          id_token: await createSignedTestIdToken({
            iss: MASUMI_DEFAULT_OIDC_ISSUER,
            sub: 'user-123',
            aud: ['masumi-spacetime-cli'],
            email: 'agent@example.com',
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { keys: [testPublicJwk] })) as typeof fetch;

    const calls: string[] = [];
    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    const result = await login({
      profileName: 'default',
      reporter,
      secretStore,
      waitForEnter: async url => {
        calls.push(`wait:${url}`);
      },
      openBrowser: async url => {
        calls.push(`open:${url}`);
        return true;
      },
      sleep: async () => {},
    });

    expect(calls).toEqual([
      `wait:${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
      `open:${MASUMI_DEFAULT_OIDC_ISSUER}/device?user_code=ABCD-EFGH`,
    ]);
    expect(result.authenticated).toBe(true);
    expect(result.email).toBe('agent@example.com');
    expect(result.grantedScopes).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'inbox-agents:read:preprod',
    ]);
    expect(secretStore.setOidcSession).toHaveBeenCalledTimes(1);
  });

  it('completes auth wait with a supplied device code', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issuer: MASUMI_DEFAULT_OIDC_ISSUER,
          authorization_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/authorize`,
          token_endpoint: `${MASUMI_DEFAULT_OIDC_ISSUER}/api/auth/oauth2/token`,
          jwks_uri: `${MASUMI_DEFAULT_OIDC_ISSUER}/.well-known/jwks.json`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          scope: 'openid profile email offline_access inbox-agents:write:mainnet',
          id_token: await createSignedTestIdToken({
            iss: MASUMI_DEFAULT_OIDC_ISSUER,
            sub: 'user-123',
            aud: ['masumi-spacetime-cli'],
            email: 'agent@example.com',
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { keys: [testPublicJwk] })) as typeof fetch;

    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    const result = await waitForLogin({
      profileName: 'default',
      pollingCode: 'device-123',
      reporter,
      secretStore,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      authenticated: true,
      profile: 'default',
      issuer: MASUMI_DEFAULT_OIDC_ISSUER,
      email: 'agent@example.com',
      subject: 'user-123',
      grantedScopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'inbox-agents:write:mainnet',
      ],
    });
    expect(secretStore.setOidcSession).toHaveBeenCalledTimes(1);
  });

  it('clears the local session and requests re-login when the refresh token is invalid', async () => {
    const expiringSession = {
      idToken: await createSignedTestIdToken({
        iss: MASUMI_DEFAULT_OIDC_ISSUER,
        sub: 'user-123',
        aud: ['masumi-spacetime-cli'],
        email: 'agent@example.com',
        email_verified: true,
        exp: Math.floor((Date.now() + 60_000) / 1000),
      }),
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid', 'profile', 'email', 'offline_access'],
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 60_000,
    };

    mockAuthIssuerFetch({
      tokenResponse: jsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'invalid refresh token',
      }),
    });

    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockResolvedValueOnce(expiringSession);

    await expect(
      ensureAuthenticatedSession({
        profileName: 'default',
        reporter,
        secretStore,
      })
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Your sign-in session expired or was revoked. Run `masumi-agent-messenger account login` again.',
    });

    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });

  it('clears a persisted unsigned id_token and requests re-login', async () => {
    const storedSession = {
      idToken: createTestIdToken({
        iss: MASUMI_DEFAULT_OIDC_ISSUER,
        sub: 'user-123',
        aud: ['masumi-spacetime-cli'],
        email: 'agent@example.com',
        email_verified: true,
        exp: Math.floor((Date.now() + 3_600_000) / 1000),
      }),
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid', 'profile', 'email', 'offline_access'],
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now() - 60_000,
    };

    mockAuthIssuerFetch();

    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockResolvedValueOnce(storedSession);

    await expect(
      ensureAuthenticatedSession({
        profileName: 'default',
        reporter,
        secretStore,
      })
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Local OIDC session is invalid. Run `masumi-agent-messenger account login` again.',
    });

    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });

  it('clears a malformed local session and requests re-login', async () => {
    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockResolvedValueOnce({
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid'],
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 60_000,
    } as unknown as Awaited<ReturnType<SecretStore['getOidcSession']>>);

    await expect(
      ensureAuthenticatedSession({
        profileName: 'default',
        reporter,
        secretStore,
      })
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Local OIDC session is invalid. Run `masumi-agent-messenger account login` again.',
    });

    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });

  it('clears an unreadable local session entry and requests re-login', async () => {
    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockRejectedValueOnce(new SyntaxError('bad JSON'));

    await expect(
      ensureAuthenticatedSession({
        profileName: 'default',
        reporter,
        secretStore,
      })
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Local OIDC session is invalid. Run `masumi-agent-messenger account login` again.',
    });

    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });

  it('treats a malformed local session as signed out in auth status', async () => {
    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockResolvedValueOnce({
      idToken: 42,
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid'],
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 60_000,
    } as unknown as Awaited<ReturnType<SecretStore['getOidcSession']>>);

    const result = await authStatus({
      profileName: 'default',
      reporter,
      secretStore,
    });

    expect(result).toMatchObject({
      authenticated: false,
      profile: 'default',
      expiresAt: null,
      email: null,
      subject: null,
      issuer: null,
      grantedScopes: [],
    });
    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });

  it('treats an invalid refresh token as signed out in auth status', async () => {
    const expiringSession = {
      idToken: await createSignedTestIdToken({
        iss: MASUMI_DEFAULT_OIDC_ISSUER,
        sub: 'user-123',
        aud: ['masumi-spacetime-cli'],
        email: 'agent@example.com',
        email_verified: true,
        exp: Math.floor((Date.now() + 60_000) / 1000),
      }),
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid', 'profile', 'email', 'offline_access'],
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 60_000,
    };

    mockAuthIssuerFetch({
      tokenResponse: jsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'invalid refresh token',
      }),
    });

    const reporter = createReporter();
    const secretStore = createSecretStoreStub();
    vi.mocked(secretStore.getOidcSession).mockResolvedValueOnce(expiringSession);

    const result = await authStatus({
      profileName: 'default',
      reporter,
      secretStore,
    });

    expect(result).toMatchObject({
      authenticated: false,
      profile: 'default',
      expiresAt: null,
      email: null,
      subject: null,
      issuer: null,
      grantedScopes: [],
    });
    expect(secretStore.deleteOidcSession).toHaveBeenCalledWith('default');
  });
});
