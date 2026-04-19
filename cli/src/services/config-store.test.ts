import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MASUMI_OIDC_SCOPE_STRING } from '../../../shared/masumi-oidc-scopes';
import {
  DEFAULT_SPACETIMEDB_DB_NAME,
  DEFAULT_SPACETIMEDB_HOST,
  loadProfile,
  resolveConfigFilePath,
  saveBootstrapSnapshot,
} from './config-store';
import { DEFAULT_OIDC_ISSUER } from './env';

describe('config-store', () => {
  let tempDir: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalHost = process.env.SPACETIMEDB_HOST;
  const originalDbName = process.env.SPACETIMEDB_DB_NAME;

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = value;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-config-'));
    process.env.XDG_CONFIG_HOME = tempDir;
    process.env.SPACETIMEDB_HOST = 'ws://example.test:3000';
    delete process.env.SPACETIMEDB_DB_NAME;
  });

  afterEach(async () => {
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
    restoreEnv('SPACETIMEDB_HOST', originalHost);
    restoreEnv('SPACETIMEDB_DB_NAME', originalDbName);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses the generated deployment target without persisting it in the profile', async () => {
    const profile = await loadProfile('default', {
      issuer: 'http://issuer.test',
      clientId: 'custom-client',
    });
    const stored = JSON.parse(await readFile(resolveConfigFilePath(), 'utf8')) as {
      profiles: Record<string, { spacetimeHost?: string; spacetimeDbName?: string }>;
    };

    expect(profile.issuer).toBe('http://issuer.test');
    expect(profile.clientId).toBe('custom-client');
    expect(profile.spacetimeHost).toBe(DEFAULT_SPACETIMEDB_HOST);
    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.spacetimeHost).toBeUndefined();
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
    expect(resolveConfigFilePath()).toContain(tempDir);
  });

  it('migrates legacy profile without new auth fields', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://legacy-issuer.test',
            clientId: 'legacy-client',
            spacetimeHost: 'ws://legacy.test:3000',
            spacetimeDbName: 'legacy-db',
          },
        },
      }),
      'utf8'
    );

    const profile = await loadProfile('default');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<
        string,
        { oidcScope?: string; spacetimeHost?: string; spacetimeDbName?: string }
      >;
    };

    expect(profile.issuer).toBe(DEFAULT_OIDC_ISSUER);
    expect(profile.oidcScope).toBe(DEFAULT_MASUMI_OIDC_SCOPE_STRING);
    expect(profile.spacetimeHost).toBe(DEFAULT_SPACETIMEDB_HOST);
    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.oidcScope).toBe(DEFAULT_MASUMI_OIDC_SCOPE_STRING);
    expect(stored.profiles.default.spacetimeHost).toBeUndefined();
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('moves the old npm default profile from the dev database to production', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://legacy-issuer.test',
            clientId: 'legacy-client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'wss://maincloud.spacetimedb.com',
            spacetimeDbName: 'agentmessenger-dev',
          },
        },
      }),
      'utf8'
    );

    const profile = await loadProfile('default');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('moves the hyphenated old npm default profile from the dev database to production', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://legacy-issuer.test',
            clientId: 'legacy-client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'wss://maincloud.spacetimedb.com',
            spacetimeDbName: 'agent-messenger-dev',
          },
        },
      }),
      'utf8'
    );

    const profile = await loadProfile('default');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('moves the hyphenated old npm default profile from the old production database to production', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://legacy-issuer.test',
            clientId: 'legacy-client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'wss://maincloud.spacetimedb.com',
            spacetimeDbName: 'agent-messenger',
          },
        },
      }),
      'utf8'
    );

    const profile = await loadProfile('default');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('moves legacy database aliases for non-default profiles and custom hosts', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'workspace',
        profiles: {
          workspace: {
            issuer: 'http://legacy-issuer.test',
            clientId: 'legacy-client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'ws://localhost:3000',
            spacetimeDbName: 'agent-messenger-dev',
          },
        },
      }),
      'utf8'
    );

    const profile = await loadProfile('workspace');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.workspace.spacetimeDbName).toBeUndefined();
  });

  it('ignores a legacy maincloud db loaded from the runtime environment', async () => {
    process.env.SPACETIMEDB_HOST = 'wss://maincloud.spacetimedb.com';
    process.env.SPACETIMEDB_DB_NAME = 'agent-messenger-dev';

    const profile = await loadProfile('default');

    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
  });

  it('ignores the old production db loaded from the runtime environment', async () => {
    process.env.SPACETIMEDB_HOST = 'ws://localhost:3000';
    process.env.SPACETIMEDB_DB_NAME = 'agent-messenger';

    const profile = await loadProfile('default');

    expect(profile.spacetimeHost).toBe(DEFAULT_SPACETIMEDB_HOST);
    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
  });

  it('normalizes legacy database aliases passed as explicit runtime overrides without persisting them', async () => {
    const profile = await loadProfile('default', {
      spacetimeHost: 'ws://localhost:3000',
      spacetimeDbName: 'agent-messenger',
    });
    const stored = JSON.parse(await readFile(resolveConfigFilePath(), 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeHost).toBe('ws://localhost:3000');
    expect(profile.spacetimeDbName).toBe(DEFAULT_SPACETIMEDB_DB_NAME);
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('uses custom database names for explicit runtime overrides without persisting them', async () => {
    const profile = await loadProfile('default', {
      spacetimeHost: 'ws://localhost:3000',
      spacetimeDbName: 'local-inbox-dev',
    });
    const stored = JSON.parse(await readFile(resolveConfigFilePath(), 'utf8')) as {
      profiles: Record<string, { spacetimeDbName?: string }>;
    };

    expect(profile.spacetimeHost).toBe('ws://localhost:3000');
    expect(profile.spacetimeDbName).toBe('local-inbox-dev');
    expect(stored.profiles.default.spacetimeDbName).toBeUndefined();
  });

  it('repairs the stored active slug when a bootstrap changes the default actor slug', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://issuer.test',
            clientId: 'client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'ws://legacy.test:3000',
            spacetimeDbName: 'legacy-db',
            activeAgentSlug: 'sandro-schaier-io',
            bootstrapSnapshot: {
              email: 'sandro@example.com',
              spacetimeIdentity: 'identity-old',
              inbox: {
                id: '1',
                normalizedEmail: 'sandro@example.com',
                displayEmail: 'sandro@example.com',
              },
              actor: {
                id: '2',
                slug: 'sandro-schaier-io',
                publicIdentity: 'sandro-schaier-io',
                displayName: 'Sandro',
              },
              keyVersions: {
                encryption: 'enc-v1',
                signing: 'sig-v1',
              },
              updatedAt: '2026-04-15T09:00:00.000Z',
            },
          },
        },
      }),
      'utf8'
    );

    const profile = await saveBootstrapSnapshot('default', {
      email: 'sandro@example.com',
      spacetimeIdentity: 'identity-new',
      inbox: {
        id: '1',
        normalizedEmail: 'sandro@example.com',
        displayEmail: 'sandro@example.com',
      },
      actor: {
        id: '2',
        slug: 'sandro-t-schaier-gmail-com',
        publicIdentity: 'sandro-t-schaier-gmail-com',
        displayName: 'Sandro',
      },
      keyVersions: {
        encryption: 'enc-v1',
        signing: 'sig-v1',
      },
      updatedAt: '2026-04-15T10:00:00.000Z',
    });

    expect(profile.activeAgentSlug).toBe('sandro-t-schaier-gmail-com');
  });

  it('preserves an explicitly selected non-default agent across bootstrap updates', async () => {
    const configPath = resolveConfigFilePath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: {
            issuer: 'http://issuer.test',
            clientId: 'client',
            oidcScope: DEFAULT_MASUMI_OIDC_SCOPE_STRING,
            spacetimeHost: 'ws://legacy.test:3000',
            spacetimeDbName: 'legacy-db',
            activeAgentSlug: 'project-bot',
            bootstrapSnapshot: {
              email: 'sandro@example.com',
              spacetimeIdentity: 'identity-old',
              inbox: {
                id: '1',
                normalizedEmail: 'sandro@example.com',
                displayEmail: 'sandro@example.com',
              },
              actor: {
                id: '2',
                slug: 'sandro-schaier-io',
                publicIdentity: 'sandro-schaier-io',
                displayName: 'Sandro',
              },
              keyVersions: {
                encryption: 'enc-v1',
                signing: 'sig-v1',
              },
              updatedAt: '2026-04-15T09:00:00.000Z',
            },
          },
        },
      }),
      'utf8'
    );

    const profile = await saveBootstrapSnapshot('default', {
      email: 'sandro@example.com',
      spacetimeIdentity: 'identity-new',
      inbox: {
        id: '1',
        normalizedEmail: 'sandro@example.com',
        displayEmail: 'sandro@example.com',
      },
      actor: {
        id: '2',
        slug: 'sandro-t-schaier-gmail-com',
        publicIdentity: 'sandro-t-schaier-gmail-com',
        displayName: 'Sandro',
      },
      keyVersions: {
        encryption: 'enc-v1',
        signing: 'sig-v1',
      },
      updatedAt: '2026-04-15T10:00:00.000Z',
    });

    expect(profile.activeAgentSlug).toBe('project-bot');
  });
});
