import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKeyPair } from '../../../shared/agent-crypto';
import type {
  DeviceKeyPair,
  SharedActorKeyMaterial,
} from '../../../shared/device-sharing';
import type { StoredOidcSession } from './oidc';
import { userError } from './errors';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = 'masumi-agent-messenger';

export type KeychainBackend = {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

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

function createLinuxBackend(): KeychainBackend {
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
        throw userError('Unable to delete secret from libsecret.', {
          code: 'KEYCHAIN_DELETE_FAILED',
          cause: error,
        });
      }
    },
  };
}

function createDefaultBackend(): KeychainBackend {
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
