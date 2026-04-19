import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocumentCsp } from '@/lib/security';
// @ts-expect-error Vitest loads this local .mjs helper at runtime.
import { appendServerSecurityHeaders, buildServerDocumentCsp } from '../../../server-security-headers.mjs';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

describe('production server security headers', () => {
  it('keeps the production CSP aligned with the app security helper', () => {
    expect(buildServerDocumentCsp()).toBe(buildDocumentCsp({ isDev: false }));
  });

  it('adds the app-wide baseline and document CSP for html responses', () => {
    const headers = appendServerSecurityHeaders(
      new Headers({
        'content-type': 'text/html; charset=utf-8',
      }),
      {
        contentType: 'text/html; charset=utf-8',
        isSecureTransport: true,
      }
    );

    expect(headers.get('Referrer-Policy')).toBe('same-origin');
    expect(headers.get('Permissions-Policy')).toContain('microphone=()');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
  });

  it('keeps non-document responses on the baseline without forcing CSP or HSTS', () => {
    const headers = appendServerSecurityHeaders(
      new Headers({
        'content-type': 'text/css; charset=utf-8',
      }),
      {
        contentType: 'text/css; charset=utf-8',
        isSecureTransport: false,
      }
    );

    expect(headers.get('Referrer-Policy')).toBe('same-origin');
    expect(headers.has('Content-Security-Policy')).toBe(false);
    expect(headers.has('Strict-Transport-Security')).toBe(false);
  });

  it('routes production server responses through the shared header helper', () => {
    const serverSource = readFileSync(resolve(WEBAPP_ROOT, 'server.mjs'), 'utf8');

    expect(serverSource).toContain("import { appendServerSecurityHeaders } from './server-security-headers.mjs'");
    expect(serverSource).toContain('appendServerSecurityHeaders(nextHeaders');
  });
});
