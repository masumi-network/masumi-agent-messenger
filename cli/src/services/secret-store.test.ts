import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeychainBackend } from './secret-store';
import {
  createFileBackend,
  createLinuxBackend,
  createReadThroughBackend,
  createSecretStore,
  inspectSecretSources,
} from './secret-store';

function createMemoryBackend(initialEntries?: Record<string, string>): KeychainBackend {
  const values = new Map<string, string>(Object.entries(initialEntries ?? {}));
  return {
    async get(account) {
      return values.get(account) ?? null;
    },
    async set(account, value) {
      values.set(account, value);
    },
    async delete(account) {
      return values.delete(account);
    },
  };
}

function createMissingSecretToolError(): NodeJS.ErrnoException {
  const error = new Error('spawn secret-tool ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function createLockedCollectionError(): Error {
  return new Error('secret-tool: Cannot create an item in a locked collection');
}

describe('secret-store', () => {
  it('serializes and restores structured secrets through backend', async () => {
    const backend = createMemoryBackend();
    const store = createSecretStore(backend);

    await store.setOidcSession('default', {
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234,
      createdAt: 5678,
    });

    expect(await store.getOidcSession('default')).toEqual({
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234,
      createdAt: 5678,
    });
    expect(await store.deleteOidcSession('default')).toBe(true);
    expect(await store.getOidcSession('default')).toBeNull();
  });

  it('surfaces backend failures', async () => {
    const backend: KeychainBackend = {
      async get() {
        return null;
      },
      async set() {
        throw new Error('boom');
      },
      async delete() {
        return false;
      },
    };
    const store = createSecretStore(backend);

    await expect(
      store.setAgentKeyPair('default', {
        encryption: {
          publicKey: 'pub',
          privateKey: 'priv',
          keyVersion: 'enc-v1',
          algorithm: 'ecdh-p256-v1',
        },
        signing: {
          publicKey: 'pub',
          privateKey: 'priv',
          keyVersion: 'sig-v1',
          algorithm: 'ecdsa-p256-sha256-v1',
        },
      })
    ).rejects.toThrow('boom');
  });

  it('stores fallback secrets in a restricted local file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-secrets-'));
    const filePath = path.join(tempDir, 'secrets.json');
    try {
      const backend = createFileBackend(filePath);

      await backend.set('default:oidc', 'session-json');

      expect(await backend.get('default:oidc')).toBe('session-json');
      expect(await backend.get('missing')).toBeNull();
      expect(await backend.delete('default:oidc')).toBe(true);
      expect(await backend.delete('default:oidc')).toBe(false);

      const mode = (await stat(filePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves existing fallback secrets while updating one entry', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-secrets-'));
    const filePath = path.join(tempDir, 'secrets.json');
    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          entries: {
            'default:agent-keypair': 'keypair-json',
          },
        }),
        'utf8'
      );

      const backend = createFileBackend(filePath);
      await backend.set('default:oidc', 'session-json');

      const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
        entries: Record<string, string>;
      };
      expect(stored.entries['default:agent-keypair']).toBe('keypair-json');
      expect(stored.entries['default:oidc']).toBe('session-json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not mutate non-primary backends on write', async () => {
    // Read-through composite: libsecret unreachable for reads → primary becomes file.
    // Writes must NOT touch other backends (the previous bug wiped the file copy
    // after a successful libsecret write).
    const fileBackend = createMemoryBackend({
      'default:oidc': 'pre-existing-file-value',
    });
    const libsecretValues = new Map<string, string>();
    const libsecretBackend: KeychainBackend = {
      async get() {
        throw createMissingSecretToolError();
      },
      async set() {
        throw createMissingSecretToolError();
      },
      async delete() {
        return false;
      },
    };
    const backend = createLinuxBackend({ libsecretBackend, fileBackend });

    await backend.set('default:oidc', 'fresh-session-json');

    // libsecret is the first candidate, but its set throws (no secret-tool)
    // → primary falls through to file. The libsecret value is never written,
    // and the file copy is updated, not the libsecret store.
    expect(libsecretValues.get('default:oidc')).toBeUndefined();
    expect(await fileBackend.get('default:oidc')).toBe('fresh-session-json');
  });

  it('writes to libsecret without erasing the file copy when libsecret is reachable', async () => {
    const fileBackend = createMemoryBackend({
      'default:oidc': 'pre-existing-file-value',
    });
    const libsecretValues = new Map<string, string>();
    const libsecretBackend: KeychainBackend = {
      async get(account) {
        return libsecretValues.get(account) ?? null;
      },
      async set(account, value) {
        libsecretValues.set(account, value);
      },
      async delete(account) {
        return libsecretValues.delete(account);
      },
    };
    const backend = createLinuxBackend({ libsecretBackend, fileBackend });

    await backend.set('default:oidc', 'fresh-session-json');

    // Primary is libsecret (first reachable candidate). File copy is intentionally left alone.
    expect(libsecretValues.get('default:oidc')).toBe('fresh-session-json');
    expect(await fileBackend.get('default:oidc')).toBe('pre-existing-file-value');
    // Read-through returns libsecret first.
    expect(await backend.get('default:oidc')).toBe('fresh-session-json');
  });

  it('read-through returns the first non-null candidate without querying the rest', async () => {
    const calls: string[] = [];
    const first: KeychainBackend = {
      async get(account) {
        calls.push(`first:${account}`);
        return 'first-value';
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    const second: KeychainBackend = {
      async get(account) {
        calls.push(`second:${account}`);
        return 'second-value';
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    const backend = createReadThroughBackend([
      { id: 'libsecret', label: 'first', backend: first },
      { id: 'file', label: 'second', backend: second },
    ]);

    expect(await backend.get('account-a')).toBe('first-value');
    expect(calls).toEqual(['first:account-a']);
  });

  it('inspectSecretSources reports per-backend presence and unavailability', async () => {
    const file = createMemoryBackend({
      'default:agent-keypair': '{"file":true}',
    });
    const libsecret: KeychainBackend = {
      async get() {
        throw createLockedCollectionError();
      },
      async set() {
        throw createLockedCollectionError();
      },
      async delete() {
        throw createLockedCollectionError();
      },
    };
    const report = await inspectSecretSources('default', [
      { id: 'libsecret', label: 'libsecret', backend: libsecret },
      { id: 'file', label: 'file (~/.config)', backend: file },
    ]);

    expect(report.primary).toBe('file');
    const libsecretSource = report.sources.find(s => s.backendId === 'libsecret')!;
    expect(libsecretSource.available).toBe(false);
    expect(libsecretSource.unavailableReason).toContain('locked collection');
    const fileSource = report.sources.find(s => s.backendId === 'file')!;
    expect(fileSource.available).toBe(true);
    expect(fileSource.secrets['agent-keypair']).toBe('{"file":true}');
  });

  it('inspectSecretSources surfaces duplicates when the same kind exists in multiple backends', async () => {
    const file = createMemoryBackend({
      'default:agent-keypair': 'shared-value',
    });
    const libsecret = createMemoryBackend({
      'default:agent-keypair': 'shared-value',
    });
    const report = await inspectSecretSources('default', [
      { id: 'libsecret', label: 'libsecret', backend: libsecret },
      { id: 'file', label: 'file (~/.config)', backend: file },
    ]);

    expect(report.sources[0]!.secrets['agent-keypair']).toBe('shared-value');
    expect(report.sources[1]!.secrets['agent-keypair']).toBe('shared-value');
    expect(report.primary).toBe('libsecret');
  });

  it('falls back to file backend when libsecret collection is locked', async () => {
    const fileBackend = createMemoryBackend();
    const libsecretBackend: KeychainBackend = {
      async get() {
        throw createLockedCollectionError();
      },
      async set() {
        throw createLockedCollectionError();
      },
      async delete() {
        return false;
      },
    };
    const backend = createLinuxBackend({ libsecretBackend, fileBackend });

    await backend.set('default:oidc', 'session-json');

    expect(await fileBackend.get('default:oidc')).toBe('session-json');
    expect(await backend.get('default:oidc')).toBe('session-json');
  });

  it('serializes concurrent fallback writes without losing entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-secrets-'));
    const filePath = path.join(tempDir, 'secrets.json');
    try {
      const backend = createFileBackend(filePath);
      const accounts = Array.from({ length: 20 }, (_, index) => `default:secret-${index}`);

      await Promise.all(
        accounts.map((account, index) => backend.set(account, `value-${index}`))
      );

      await Promise.all(
        accounts.map(async (account, index) => {
          await expect(backend.get(account)).resolves.toBe(`value-${index}`);
        })
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('recovers a stale fallback lock left by a crashed process', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'masumi-cli-secrets-'));
    const filePath = path.join(tempDir, 'secrets.json');
    const lockPath = `${filePath}.lock`;
    try {
      await mkdir(lockPath, { recursive: true });
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleTime, staleTime);

      const backend = createFileBackend(filePath);
      await backend.set('default:oidc', 'session-json');

      await expect(backend.get('default:oidc')).resolves.toBe('session-json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
