import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { lock as acquireLock } from 'proper-lockfile';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type {
  DeviceKeyPair,
  SharedActorKeyMaterial,
} from '../../../shared/device-sharing';
import { resolveConfigDirectory } from './config-store';
import type { StoredOidcSession } from './oidc';
import { userError } from './errors';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = 'masumi-agent-messenger';
const FILE_STORE_VERSION = 1;
const FILE_STORE_LOCK_STALE_MS = 5000;
const FILE_STORE_LOCK_RETRY_MS = 50;
const FILE_STORE_LOCK_RETRIES = 120;

export type KeychainBackend = {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

type FileSecretStoreDocument = {
  version: typeof FILE_STORE_VERSION;
  entries: Record<string, string>;
};

function hasErrorCode(error: unknown, code: string | number): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function isLibsecretUnavailableError(error: unknown): boolean {
  if (hasErrorCode(error, 'ENOENT')) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('spawn secret-tool enoent') ||
    message.includes('cannot autolaunch d-bus') ||
    message.includes('org.freedesktop.secrets') ||
    message.includes('no such secret collection') ||
    message.includes('failed to execute child process "dbus-launch"') ||
    message.includes('could not connect') ||
    message.includes("couldn't connect") ||
    message.includes('name is not activatable') ||
    message.includes('cannot create an item in a locked collection')
  );
}

async function runWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });

    child.stdin.end(input, 'utf8');
  });
}

function resolveFileSecretStorePath(): string {
  return path.join(resolveConfigDirectory(), 'secrets.json');
}

async function ensureFileSecretStoreDirectory(filePath: string): Promise<string> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

function createEmptyFileSecretStoreDocument(): FileSecretStoreDocument {
  return {
    version: FILE_STORE_VERSION,
    entries: {},
  };
}

function parseFileSecretStoreDocument(raw: string): FileSecretStoreDocument {
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw userError('Local secret store is invalid: root value must be an object.', {
      code: 'LOCAL_SECRET_STORE_INVALID',
    });
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== FILE_STORE_VERSION) {
    throw userError('Local secret store is invalid: unsupported version.', {
      code: 'LOCAL_SECRET_STORE_INVALID',
    });
  }

  if (
    typeof record.entries !== 'object' ||
    record.entries === null ||
    Array.isArray(record.entries)
  ) {
    throw userError('Local secret store is invalid: entries must be an object.', {
      code: 'LOCAL_SECRET_STORE_INVALID',
    });
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.entries)) {
    if (typeof value !== 'string') {
      throw userError('Local secret store is invalid: entries must be strings.', {
        code: 'LOCAL_SECRET_STORE_INVALID',
      });
    }
    entries[key] = value;
  }

  return {
    version: FILE_STORE_VERSION,
    entries,
  };
}

async function readFileSecretStore(filePath: string): Promise<FileSecretStoreDocument> {
  try {
    return parseFileSecretStoreDocument(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return createEmptyFileSecretStoreDocument();
    }
    if (error instanceof SyntaxError) {
      throw userError('Local secret store is invalid: expected JSON.', {
        code: 'LOCAL_SECRET_STORE_INVALID',
        cause: error,
      });
    }
    throw error;
  }
}

async function writeFileSecretStore(
  filePath: string,
  document: FileSecretStoreDocument
): Promise<void> {
  const directory = await ensureFileSecretStoreDirectory(filePath);

  const tempPath = path.join(directory, `.secrets-${process.pid}-${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function withFileSecretStoreLock<T>(
  filePath: string,
  action: () => Promise<T>
): Promise<T> {
  await ensureFileSecretStoreDirectory(filePath);

  let release: () => Promise<void>;
  try {
    release = await acquireLock(filePath, {
      realpath: false,
      stale: FILE_STORE_LOCK_STALE_MS,
      update: 1000,
      retries: {
        retries: FILE_STORE_LOCK_RETRIES,
        factor: 1,
        minTimeout: FILE_STORE_LOCK_RETRY_MS,
        maxTimeout: FILE_STORE_LOCK_RETRY_MS,
      },
    });
  } catch (error) {
    throw userError('Local secret store is busy. Try again in a moment.', {
      code: 'LOCAL_SECRET_STORE_BUSY',
      cause: error,
    });
  }

  try {
    return await action();
  } finally {
    await release();
  }
}

export function createFileBackend(filePath = resolveFileSecretStorePath()): KeychainBackend {
  return {
    async get(account) {
      const document = await readFileSecretStore(filePath);
      return document.entries[account] ?? null;
    },
    async set(account, value) {
      await withFileSecretStoreLock(filePath, async () => {
        const document = await readFileSecretStore(filePath);
        document.entries[account] = value;
        await writeFileSecretStore(filePath, document);
      });
    },
    async delete(account) {
      return withFileSecretStoreLock(filePath, async () => {
        const document = await readFileSecretStore(filePath);
        if (!(account in document.entries)) {
          return false;
        }
        delete document.entries[account];
        await writeFileSecretStore(filePath, document);
        return true;
      });
    },
  };
}

function createMacOsBackend(): KeychainBackend {
  return {
    async get(account) {
      try {
        const { stdout } = await execFileAsync('security', [
          'find-generic-password',
          '-s',
          SERVICE_NAME,
          '-a',
          account,
          '-w',
        ]);
        return stdout.trim() || null;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'number'
        ) {
          return null;
        }
        throw userError('Unable to read secret from macOS Keychain.', {
          code: 'KEYCHAIN_GET_FAILED',
          cause: error,
        });
      }
    },
    async set(account, value) {
      try {
        await execFileAsync('security', [
          'add-generic-password',
          '-U',
          '-s',
          SERVICE_NAME,
          '-a',
          account,
          '-w',
          value,
        ]);
      } catch (error) {
        throw userError('Unable to write secret to macOS Keychain.', {
          code: 'KEYCHAIN_SET_FAILED',
          cause: error,
        });
      }
    },
    async delete(account) {
      try {
        await execFileAsync('security', [
          'delete-generic-password',
          '-s',
          SERVICE_NAME,
          '-a',
          account,
        ]);
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'number'
        ) {
          return false;
        }
        throw userError('Unable to delete secret from macOS Keychain.', {
          code: 'KEYCHAIN_DELETE_FAILED',
          cause: error,
        });
      }
    },
  };
}

export function createLinuxBackend(params?: {
  libsecretBackend?: KeychainBackend;
  fileBackend?: KeychainBackend;
}): KeychainBackend {
  const libsecretBackend = params?.libsecretBackend ?? createLibsecretBackend();
  const fileBackend = params?.fileBackend ?? createFileBackend();

  return {
    async get(account) {
      try {
        return (await libsecretBackend.get(account)) ?? (await fileBackend.get(account));
      } catch (error) {
        if (isLibsecretUnavailableError(error)) {
          return fileBackend.get(account);
        }
        throw error;
      }
    },
    async set(account, value) {
      try {
        await libsecretBackend.set(account, value);
        await fileBackend.delete(account);
      } catch (error) {
        if (isLibsecretUnavailableError(error)) {
          await fileBackend.set(account, value);
          return;
        }
        throw error;
      }
    },
    async delete(account) {
      let deleted = false;
      try {
        deleted = await libsecretBackend.delete(account);
      } catch (error) {
        if (!isLibsecretUnavailableError(error)) {
          throw error;
        }
      }

      return (await fileBackend.delete(account)) || deleted;
    },
  };
}

function createLibsecretBackend(): KeychainBackend {
  return {
    async get(account) {
      try {
        const { stdout } = await execFileAsync('secret-tool', [
          'lookup',
          'service',
          SERVICE_NAME,
          'account',
          account,
        ]);
        return stdout.trim() || null;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'number'
        ) {
          return null;
        }
        if (isLibsecretUnavailableError(error)) {
          throw error;
        }
        throw userError('Unable to read secret from libsecret.', {
          code: 'KEYCHAIN_GET_FAILED',
          cause: error,
        });
      }
    },
    async set(account, value) {
      try {
        await runWithInput(
          'secret-tool',
          ['store', '--label', `${SERVICE_NAME}:${account}`, 'service', SERVICE_NAME, 'account', account],
          value
        );
      } catch (error) {
        if (isLibsecretUnavailableError(error)) {
          throw error;
        }
        throw userError('Unable to write secret to libsecret.', {
          code: 'KEYCHAIN_SET_FAILED',
          cause: error,
        });
      }
    },
    async delete(account) {
      try {
        await execFileAsync('secret-tool', [
          'clear',
          'service',
          SERVICE_NAME,
          'account',
          account,
        ]);
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'number'
        ) {
          return false;
        }
        if (isLibsecretUnavailableError(error)) {
          throw error;
        }
        throw userError('Unable to delete secret from libsecret.', {
          code: 'KEYCHAIN_DELETE_FAILED',
          cause: error,
        });
      }
    },
  };
}

function createDefaultBackend(): KeychainBackend {
  if (process.env.MASUMI_FORCE_FILE_BACKEND === '1' || process.env.MASUMI_FORCE_FILE_BACKEND === 'true') {
    return createFileBackend();
  }

  if (process.platform === 'darwin') {
    return createMacOsBackend();
  }

  if (process.platform === 'linux') {
    return createLinuxBackend();
  }

  throw userError(
    `OS keychain adapter is not available on ${process.platform}.`,
    { code: 'KEYCHAIN_UNSUPPORTED_PLATFORM' }
  );
}

type SecretKind = 'oidc' | 'agent-keypair' | 'device-keypair' | 'namespace-key-vault';

export type DeviceKeyMaterial = {
  deviceId: string;
  keyPair: DeviceKeyPair;
};

export type NamespaceKeyVault = {
  version: 1;
  normalizedEmail: string;
  actors: SharedActorKeyMaterial[];
};

function accountKey(profileName: string, kind: SecretKind): string {
  return `${profileName}:${kind}`;
}

export type SecretStore = ReturnType<typeof createSecretStore>;

export function createSecretStore(backend: KeychainBackend = createDefaultBackend()) {
  return {
    async getOidcSession(profileName: string): Promise<StoredOidcSession | null> {
      const secret = await backend.get(accountKey(profileName, 'oidc'));
      if (!secret) return null;
      return JSON.parse(secret) as StoredOidcSession;
    },
    async setOidcSession(profileName: string, session: StoredOidcSession): Promise<void> {
      await backend.set(accountKey(profileName, 'oidc'), JSON.stringify(session));
    },
    async deleteOidcSession(profileName: string): Promise<boolean> {
      return backend.delete(accountKey(profileName, 'oidc'));
    },
    async getAgentKeyPair(profileName: string): Promise<AgentKeyPair | null> {
      const secret = await backend.get(accountKey(profileName, 'agent-keypair'));
      if (!secret) return null;
      return JSON.parse(secret) as AgentKeyPair;
    },
    async setAgentKeyPair(profileName: string, keyPair: AgentKeyPair): Promise<void> {
      await backend.set(accountKey(profileName, 'agent-keypair'), JSON.stringify(keyPair));
    },
    async deleteAgentKeyPair(profileName: string): Promise<boolean> {
      return backend.delete(accountKey(profileName, 'agent-keypair'));
    },
    async getDeviceKeyMaterial(profileName: string): Promise<DeviceKeyMaterial | null> {
      const secret = await backend.get(accountKey(profileName, 'device-keypair'));
      if (!secret) return null;
      return JSON.parse(secret) as DeviceKeyMaterial;
    },
    async setDeviceKeyMaterial(profileName: string, material: DeviceKeyMaterial): Promise<void> {
      await backend.set(accountKey(profileName, 'device-keypair'), JSON.stringify(material));
    },
    async deleteDeviceKeyMaterial(profileName: string): Promise<boolean> {
      return backend.delete(accountKey(profileName, 'device-keypair'));
    },
    async getNamespaceKeyVault(profileName: string): Promise<NamespaceKeyVault | null> {
      const secret = await backend.get(accountKey(profileName, 'namespace-key-vault'));
      if (!secret) return null;
      return JSON.parse(secret) as NamespaceKeyVault;
    },
    async setNamespaceKeyVault(profileName: string, vault: NamespaceKeyVault): Promise<void> {
      await backend.set(accountKey(profileName, 'namespace-key-vault'), JSON.stringify(vault));
    },
    async deleteNamespaceKeyVault(profileName: string): Promise<boolean> {
      return backend.delete(accountKey(profileName, 'namespace-key-vault'));
    },
  };
}
