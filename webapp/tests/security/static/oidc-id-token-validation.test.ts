import {
  createCipheriv,
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBrowserAuthSession, validateOidcIdToken } from '@/lib/oidc-auth.server';
import {
  GENERATED_MASUMI_OIDC_CLIENT_ID,
  GENERATED_MASUMI_OIDC_ISSUER,
} from '../../../../shared/generated-oidc-config';

const originalFetch = global.fetch;
const originalIssuer = process.env.MASUMI_OIDC_ISSUER;
const originalClientId = process.env.MASUMI_OIDC_CLIENT_ID;
const originalAudiences = process.env.MASUMI_OIDC_AUDIENCES;
const originalSessionSecret = process.env.MASUMI_SESSION_SECRET;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const { privateKey: rotatedPrivateKey, publicKey: rotatedPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const publicJwk = {
  ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
  alg: 'RS256',
  kid: 'test-key',
  use: 'sig',
};
const rotatedPublicJwk = {
  ...(rotatedPublicKey.export({ format: 'jwk' }) as JsonWebKey),
  alg: 'RS256',
  kid: 'rotated-key',
  use: 'sig',
};

const metadata = {
  issuer: GENERATED_MASUMI_OIDC_ISSUER,
  authorization_endpoint: `${GENERATED_MASUMI_OIDC_ISSUER}/authorize`,
  token_endpoint: `${GENERATED_MASUMI_OIDC_ISSUER}/token`,
  jwks_uri: `${GENERATED_MASUMI_OIDC_ISSUER}/jwks`,
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encryptSessionCookieValue(value: unknown): string {
  const iv = Buffer.alloc(12, 1);
  const key = createHash('sha256').update(process.env.MASUMI_SESSION_SECRET!).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', base64Url(iv), base64Url(tag), base64Url(ciphertext)].join('.');
}

function signJwtPayload(params: {
  privateKey: KeyObject;
  payload: Record<string, unknown>;
  kid?: string;
}): string {
  const encodedHeader = base64Url(
    JSON.stringify({
      alg: 'RS256',
      kid: params.kid ?? 'test-key',
      typ: 'JWT',
    })
  );
  const encodedPayload = base64Url(JSON.stringify(params.payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(params.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSeconds = 1_777_000_000;
  return {
    iss: GENERATED_MASUMI_OIDC_ISSUER,
    sub: 'user-123',
    aud: [GENERATED_MASUMI_OIDC_CLIENT_ID],
    exp: nowSeconds + 600,
    nbf: nowSeconds - 60,
    nonce: 'nonce-123',
    email: 'agent@example.com',
    email_verified: true,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.MASUMI_OIDC_ISSUER = GENERATED_MASUMI_OIDC_ISSUER;
  process.env.MASUMI_OIDC_CLIENT_ID = GENERATED_MASUMI_OIDC_CLIENT_ID;
  process.env.MASUMI_OIDC_AUDIENCES = GENERATED_MASUMI_OIDC_CLIENT_ID;
  process.env.MASUMI_SESSION_SECRET = 'test-session-secret';
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ keys: [publicJwk] }), {
      headers: {
        'Content-Type': 'application/json',
      },
    })
  ) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnvValue('MASUMI_OIDC_ISSUER', originalIssuer);
  restoreEnvValue('MASUMI_OIDC_CLIENT_ID', originalClientId);
  restoreEnvValue('MASUMI_OIDC_AUDIENCES', originalAudiences);
  restoreEnvValue('MASUMI_SESSION_SECRET', originalSessionSecret);
  vi.restoreAllMocks();
});

describe('OIDC id_token validation', () => {
  it('accepts a signed token for the configured issuer, audience, and nonce', async () => {
    const payload = buildPayload();
    const token = signJwtPayload({ privateKey, payload });

    await expect(
      validateOidcIdToken(token, metadata, {
        expectedNonce: 'nonce-123',
        nowMs: 1_777_000_000_000,
      })
    ).resolves.toMatchObject({
      issuer: GENERATED_MASUMI_OIDC_ISSUER,
      subject: 'user-123',
      audience: [GENERATED_MASUMI_OIDC_CLIENT_ID],
    });
  });

  it('rejects signed tokens for a different audience', async () => {
    const token = signJwtPayload({
      privateKey,
      payload: buildPayload({ aud: ['other-client'] }),
    });

    await expect(
      validateOidcIdToken(token, metadata, {
        expectedNonce: 'nonce-123',
        nowMs: 1_777_000_000_000,
      })
    ).rejects.toThrow(/audience/i);
  });

  it('rejects signed tokens authorized for a different client', async () => {
    const token = signJwtPayload({
      privateKey,
      payload: buildPayload({
        aud: [GENERATED_MASUMI_OIDC_CLIENT_ID, 'api-audience'],
        azp: 'other-client',
      }),
    });

    await expect(
      validateOidcIdToken(token, metadata, {
        expectedNonce: 'nonce-123',
        nowMs: 1_777_000_000_000,
      })
    ).rejects.toThrow(/authorized/i);
  });

  it('rejects tokens whose payload was changed after signing', async () => {
    const payload = buildPayload();
    const token = signJwtPayload({ privateKey, payload });
    const [encodedHeader, , encodedSignature] = token.split('.');
    const tampered = `${encodedHeader}.${base64Url(
      JSON.stringify({ ...payload, sub: 'attacker' })
    )}.${encodedSignature}`;

    await expect(
      validateOidcIdToken(tampered, metadata, {
        expectedNonce: 'nonce-123',
        nowMs: 1_777_000_000_000,
      })
    ).rejects.toThrow(/signature/i);
  });

  it('refetches JWKS once when a cached key set misses the token kid', async () => {
    const rotationMetadata = {
      ...metadata,
      jwks_uri: `${metadata.jwks_uri}?rotation=webapp`,
    };
    let keys: JsonWebKey[] = [publicJwk];
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys }), {
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      validateOidcIdToken(signJwtPayload({ privateKey, payload: buildPayload() }), rotationMetadata, {
        expectedNonce: 'nonce-123',
        nowMs: 1_777_000_000_000,
      })
    ).resolves.toMatchObject({
      subject: 'user-123',
    });

    keys = [rotatedPublicJwk];
    await expect(
      validateOidcIdToken(
        signJwtPayload({
          privateKey: rotatedPrivateKey,
          payload: buildPayload(),
          kid: 'rotated-key',
        }),
        rotationMetadata,
        {
          expectedNonce: 'nonce-123',
          nowMs: 1_777_000_000_000,
        }
      )
    ).resolves.toMatchObject({
      subject: 'user-123',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears a decryptable session cookie when its token is missing required claims', async () => {
    const malformedToken = signJwtPayload({
      privateKey,
      payload: buildPayload({ sub: undefined }),
    });
    const cookieValue = encryptSessionCookieValue({
      idToken: malformedToken,
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid'],
      expiresAt: 1_777_000_600_000,
      createdAt: 1_777_000_000_000,
    });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(metadata), {
        headers: {
          'Content-Type': 'application/json',
        },
      })
    ) as typeof fetch;

    const response = await readBrowserAuthSession(
      new Request(`${GENERATED_MASUMI_OIDC_ISSUER}/auth/session`, {
        headers: {
          cookie: `masumi_oidc_session=${encodeURIComponent(cookieValue)}`,
        },
      })
    );

    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get('set-cookie')).toContain('masumi_oidc_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('clears a decryptable session cookie with an invalid stored session shape', async () => {
    const cookieValue = encryptSessionCookieValue({
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      grantedScopes: ['openid'],
      expiresAt: 1_777_000_600_000,
      createdAt: 1_777_000_000_000,
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const response = await readBrowserAuthSession(
      new Request(`${GENERATED_MASUMI_OIDC_ISSUER}/auth/session`, {
        headers: {
          cookie: `masumi_oidc_session=${encodeURIComponent(cookieValue)}`,
        },
      })
    );

    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get('set-cookie')).toContain('masumi_oidc_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a decryptable session cookie with a falsy invalid payload', async () => {
    const cookieValue = encryptSessionCookieValue(false);
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const response = await readBrowserAuthSession(
      new Request(`${GENERATED_MASUMI_OIDC_ISSUER}/auth/session`, {
        headers: {
          cookie: `masumi_oidc_session=${encodeURIComponent(cookieValue)}`,
        },
      })
    );

    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get('set-cookie')).toContain('masumi_oidc_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
