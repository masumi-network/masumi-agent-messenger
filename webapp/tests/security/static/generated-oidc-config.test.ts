import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEBAPP_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const REPO_ROOT = resolve(WEBAPP_ROOT, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

type GeneratedConfig = {
  source: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcAudiences: string[];
  network: string;
  spacetimedbHost: string;
  spacetimedbDbName: string;
};

function extractStringArray(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Marker ${marker} not found`);
  }
  const after = source.slice(start + marker.length);
  const valueStart = after.indexOf('=');
  if (valueStart < 0) {
    throw new Error(`Assignment '=' missing after ${marker}`);
  }
  const open = after.indexOf('[', valueStart);
  if (open < 0) {
    throw new Error(`Array open '[' missing after ${marker}`);
  }
  const close = after.indexOf(']', open);
  if (close < 0) {
    throw new Error(`Array close ']' missing after ${marker}`);
  }
  const body = after.slice(open + 1, close);
  return [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

function extractString(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Marker ${marker} not found`);
  }
  const after = source.slice(start + marker.length);
  const match = after.match(/"([^"]+)"/);
  if (!match) {
    throw new Error(`String literal missing after ${marker}`);
  }
  return match[1];
}

function parseTsLike(source: string): GeneratedConfig {
  return {
    source: extractString(source, 'GENERATED_OIDC_CONFIG_SOURCE'),
    oidcIssuer: extractString(source, 'GENERATED_MASUMI_OIDC_ISSUER'),
    oidcClientId: extractString(source, 'GENERATED_MASUMI_OIDC_CLIENT_ID'),
    oidcAudiences: extractStringArray(source, 'GENERATED_MASUMI_OIDC_AUDIENCES'),
    network: extractString(source, 'GENERATED_MASUMI_NETWORK'),
    spacetimedbHost: extractString(source, 'GENERATED_SPACETIMEDB_HOST'),
    spacetimedbDbName: extractString(source, 'GENERATED_SPACETIMEDB_DB_NAME'),
  };
}

function parseRustConfig(source: string): GeneratedConfig {
  return {
    source: extractString(source, 'GENERATED_OIDC_CONFIG_SOURCE'),
    oidcIssuer: extractString(source, 'GENERATED_MASUMI_OIDC_ISSUER'),
    oidcClientId: extractString(source, 'GENERATED_MASUMI_OIDC_CLIENT_ID'),
    oidcAudiences: extractStringArray(source, 'GENERATED_MASUMI_OIDC_AUDIENCES'),
    network: extractString(source, 'GENERATED_MASUMI_NETWORK'),
    spacetimedbHost: extractString(source, 'GENERATED_SPACETIMEDB_HOST'),
    spacetimedbDbName: extractString(source, 'GENERATED_SPACETIMEDB_DB_NAME'),
  };
}

describe('generated OIDC config — three-source consistency', () => {
  const tsConfig = parseTsLike(readRepoFile('shared/generated-oidc-config.ts'));
  const mjsConfig = parseTsLike(readRepoFile('shared/generated-oidc-config.mjs'));
  const rustConfig = parseRustConfig(
    readRepoFile('spacetimedb/src/generated_oidc_config.rs')
  );

  it('TypeScript and ESM modules carry identical constants', () => {
    expect(tsConfig).toEqual(mjsConfig);
  });

  it('Rust module carries identical constants to the TypeScript module', () => {
    expect(rustConfig).toEqual(tsConfig);
  });

  it('every generator carries a non-empty issuer, audiences, network, and database name', () => {
    for (const config of [tsConfig, mjsConfig, rustConfig]) {
      expect(config.oidcIssuer).toMatch(/^https:\/\//);
      expect(config.oidcAudiences.length).toBeGreaterThan(0);
      expect(config.network).toMatch(/^(Preprod|Mainnet)$/);
      expect(config.spacetimedbDbName.length).toBeGreaterThan(0);
    }
  });
});
