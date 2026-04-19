import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest loads this local .mjs helper at runtime.
import { resolveServerOidcRuntimeConfig } from '../../../server-oidc-config.mjs';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

describe('production server OIDC config', () => {
  it('fails fast without explicit non-local auth config', () => {
    expect(() =>
      resolveServerOidcRuntimeConfig(
        {},
        {
          source: 'local-default',
          issuer: 'https://generated.example',
          clientId: 'generated-client',
          audiences: ['generated-web'],
        }
      )
    ).toThrow(/MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true/);
  });

  it('accepts generated explicit auth config without the local default flag', () => {
    expect(
      resolveServerOidcRuntimeConfig(
        {},
        {
          source: 'explicit',
          issuer: 'https://issuer.example',
          clientId: 'web-client',
          audiences: ['web-client', 'cli-client'],
        }
      )
    ).toEqual({
      issuer: 'https://issuer.example',
      clientId: 'web-client',
      audiences: ['web-client', 'cli-client'],
    });
  });

  it('validates OIDC config during production server startup', () => {
    const serverSource = readFileSync(resolve(WEBAPP_ROOT, 'server.mjs'), 'utf8');

    expect(serverSource).toContain("import { resolveServerOidcRuntimeConfig } from './server-oidc-config.mjs'");
    expect(serverSource).toContain('resolveServerOidcRuntimeConfig(process.env');
  });
});
