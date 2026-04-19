import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCliEnvLoaded } from './env';

describe('env loader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-env-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads workspace and cwd env files without overriding explicit shell env', async () => {
    const workspaceDir = path.join(tempDir, 'workspace');
    const cwdDir = path.join(workspaceDir, 'cli');
    await mkdir(cwdDir, { recursive: true });

    await writeFile(path.join(workspaceDir, 'pnpm-workspace.yaml'), 'packages:\n  - cli\n', 'utf8');
    await writeFile(
      path.join(workspaceDir, '.env'),
      [
        'MASUMI_OIDC_ISSUER=https://workspace.example',
        'SPACETIMEDB_HOST=wss://workspace.example',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      path.join(workspaceDir, '.env.local'),
      'SPACETIMEDB_HOST=wss://workspace-local.example\n',
      'utf8'
    );
    await writeFile(path.join(cwdDir, '.env'), 'MASUMI_OIDC_CLIENT_ID=from-cwd\n', 'utf8');
    await writeFile(
      path.join(cwdDir, '.env.local'),
      'MASUMI_OIDC_ISSUER=https://cwd-local.example\n',
      'utf8'
    );

    const env: Record<string, string | undefined> = {
      SPACETIMEDB_DB_NAME: 'from-shell',
    };

    ensureCliEnvLoaded({
      cwd: cwdDir,
      env,
    });

    expect(env.MASUMI_OIDC_ISSUER).toBe('https://cwd-local.example');
    expect(env.MASUMI_OIDC_CLIENT_ID).toBe('from-cwd');
    expect(env.SPACETIMEDB_HOST).toBe('wss://workspace-local.example');
    expect(env.SPACETIMEDB_DB_NAME).toBe('from-shell');
  });
});
