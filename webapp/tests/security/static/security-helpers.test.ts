import { describe, expect, it } from 'vitest';
import {
  appendStandardSecurityHeaders,
  buildDocumentCsp,
  isSameOriginUnsafeRequest,
  parseBooleanFlag,
  resolveOidcRuntimeConfigFromEnv,
  resolveSessionSecretFromEnv,
} from '@/lib/security';
import { sanitizeReturnTo } from '@/lib/oidc-auth.server';

describe('security helpers', () => {
  it('parses explicit boolean flags only', () => {
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('YES')).toBe(true);
    expect(parseBooleanFlag('1')).toBe(true);
    expect(parseBooleanFlag('false')).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
    expect(parseBooleanFlag('')).toBe(false);
  });

  it('requires an explicit session secret by default', () => {
    expect(() =>
      resolveSessionSecretFromEnv({
        NODE_ENV: 'development',
      })
    ).toThrow(/MASUMI_SESSION_SECRET is required/);
  });

  it('allows the insecure dev session secret only in explicit local test mode', () => {
    expect(
      resolveSessionSecretFromEnv({
        NODE_ENV: 'development',
        MASUMI_ALLOW_INSECURE_DEV_SESSION_SECRET: 'true',
      })
    ).toBe('masumi-dev-session-secret-change-me');

    expect(() =>
      resolveSessionSecretFromEnv({
        NODE_ENV: 'production',
        MASUMI_ALLOW_INSECURE_DEV_SESSION_SECRET: 'true',
      })
    ).toThrow(/MASUMI_SESSION_SECRET is required in production/);
  });

  it('accepts an explicitly configured session secret', () => {
    expect(
      resolveSessionSecretFromEnv({
        NODE_ENV: 'production',
        MASUMI_SESSION_SECRET: 'top-secret',
      })
    ).toBe('top-secret');
  });

  it('sanitizes returnTo values to same-origin relative paths', () => {
    expect(sanitizeReturnTo('/safe/path')).toBe('/safe/path');
    expect(sanitizeReturnTo('https://evil.example/steal')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.example/steal')).toBe('/');
    expect(sanitizeReturnTo('/safe\nSet-Cookie:evil')).toBe('/');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTo(null)).toBe('/');
  });

  it('builds a defense-in-depth CSP', () => {
    const csp = buildDocumentCsp({ isDev: false });
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("'unsafe-eval'");
  });

  it('appends standard security headers', () => {
    const headers = appendStandardSecurityHeaders(new Headers(), {
      includeDocumentCsp: true,
      isDev: false,
    });

    expect(headers.get('Referrer-Policy')).toBe('same-origin');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('recognizes same-origin unsafe requests and rejects cross-site ones', () => {
    const allowed = new Request('http://localhost:5173/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5173',
      },
    });
    const blocked = new Request('http://localhost:5173/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
      },
    });

    expect(isSameOriginUnsafeRequest(allowed)).toBe(true);
    expect(isSameOriginUnsafeRequest(blocked)).toBe(false);
  });

  it('requires complete explicit OIDC config when any OIDC env value is set', () => {
    expect(() =>
      resolveOidcRuntimeConfigFromEnv(
        {
          MASUMI_OIDC_ISSUER: 'https://issuer.example',
        },
        {
          source: 'explicit',
          issuer: 'https://generated.example',
          clientId: 'generated-client',
          audiences: ['generated-web'],
        }
      )
    ).toThrow(/Missing OIDC auth config: MASUMI_OIDC_CLIENT_ID, MASUMI_OIDC_AUDIENCES/);
  });

  it('accepts explicit OIDC config from env', () => {
    expect(
      resolveOidcRuntimeConfigFromEnv(
        {
          MASUMI_OIDC_ISSUER: 'https://issuer.example/',
          MASUMI_OIDC_CLIENT_ID: 'web-client',
          MASUMI_OIDC_AUDIENCES: 'web-client,cli-client',
        },
        {
          source: 'local-default',
          issuer: 'https://generated.example',
          clientId: 'generated-client',
          audiences: ['generated-web'],
        }
      )
    ).toEqual({
      issuer: 'https://issuer.example',
      clientId: 'web-client',
      audiences: ['web-client', 'cli-client'],
    });
  });

  it('requires an explicit flag before using generated local OIDC defaults', () => {
    expect(() =>
      resolveOidcRuntimeConfigFromEnv(
        {},
        {
          source: 'local-default',
          issuer: 'https://generated.example',
          clientId: 'generated-client',
          audiences: ['generated-web'],
        }
      )
    ).toThrow(/MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true/);

    expect(
      resolveOidcRuntimeConfigFromEnv(
        {
          MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG: 'true',
        },
        {
          source: 'local-default',
          issuer: 'https://generated.example',
          clientId: 'generated-client',
          audiences: ['generated-web'],
        }
      )
    ).toEqual({
      issuer: 'https://generated.example',
      clientId: 'generated-client',
      audiences: ['generated-web'],
    });
  });
});
