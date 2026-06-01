import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildNamespaceKeyBackupFileName,
  createEncryptedNamespaceKeyBackup,
  decryptEncryptedNamespaceKeyBackup,
} from '../../../shared/key-backup';
import {
  countSharedActors,
  countSharedKeyVersions,
} from '../../../shared/device-sharing';
import { normalizeEmail } from '../../../shared/inbox-slug';
import { loadProfile } from './config-store';
import { exportNamespaceKeyShareSnapshot, importNamespaceKeyShareSnapshot } from './device-keys';
import { userError } from './errors';
import type { TaskReporter } from './command-runtime';
import { ensureAuthenticatedSession } from './auth';
import { createSecretStore, type SecretStore } from './secret-store';

export type BackupInboxKeysResult = {
  profile: string;
  filePath: string;
  email: string;
  actorCount: string;
  keyVersionCount: string;
};

export type RestoreInboxKeysResult = BackupInboxKeysResult;

function defaultSecretStore(): SecretStore {
  return createSecretStore();
}

type ResolvedBackupNamespace = {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  email: string;
};

function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'AUTH_REQUIRED'
  );
}

async function resolveBackupNamespaceForExport(params: {
  profileName: string;
  reporter: TaskReporter;
  secretStore: SecretStore;
}): Promise<ResolvedBackupNamespace> {
  try {
    const auth = await ensureAuthenticatedSession({
      profileName: params.profileName,
      reporter: params.reporter,
      secretStore: params.secretStore,
    });
    const email = normalizeEmail(auth.claims.email ?? '');
    if (!email) {
      throw userError('Current OIDC session is missing a verified email claim.', {
        code: 'OIDC_EMAIL_MISSING',
      });
    }

    return {
      profile: auth.profile,
      email,
    };
  } catch (error) {
    if (!isAuthRequiredError(error)) {
      throw error;
    }

    const profile = await loadProfile(params.profileName);
    const email = profile.bootstrapSnapshot?.inbox.email ?? '';
    if (!email) {
      throw userError(
        'No inbox email namespace is known for this profile yet. Run `masumi-agent-messenger account login` in an interactive terminal, or use `masumi-agent-messenger account login start --json` and `masumi-agent-messenger account login complete --polling-code <polling-code> --json` in automation.',
        {
          code: 'BACKUP_NAMESPACE_UNKNOWN',
          cause: error,
          hint: 'masumi-agent-messenger account login start --json',
        }
      );
    }

    return {
      profile,
      email,
    };
  }
}

export async function backupInboxKeys(params: {
  profileName: string;
  filePath: string;
  passphrase: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
}): Promise<BackupInboxKeysResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const { profile, email } = await resolveBackupNamespaceForExport({
    profileName: params.profileName,
    reporter: params.reporter,
    secretStore,
  });

  const snapshot = await exportNamespaceKeyShareSnapshot({
    profile,
    secretStore,
  });
  const json = await createEncryptedNamespaceKeyBackup(snapshot, params.passphrase);
  const resolvedPath = path.resolve(params.filePath);

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${json}\n`, 'utf8');

  return {
    profile: profile.name,
    filePath: resolvedPath,
    email,
    actorCount: countSharedActors(snapshot).toString(),
    keyVersionCount: countSharedKeyVersions(snapshot).toString(),
  };
}

export async function restoreInboxKeys(params: {
  profileName: string;
  filePath: string;
  passphrase: string;
  reporter: TaskReporter;
  expectedNormalizedEmail?: string;
  secretStore?: SecretStore;
}): Promise<RestoreInboxKeysResult> {
  const secretStore = params.secretStore ?? defaultSecretStore();
  const profile = await loadProfile(params.profileName);
  const resolvedPath = path.resolve(params.filePath);
  const json = await readFile(resolvedPath, 'utf8');
  const snapshot = await decryptEncryptedNamespaceKeyBackup(json, params.passphrase);
  const expectedNormalizedEmail =
    params.expectedNormalizedEmail?.trim().toLowerCase() || snapshot.email;

  if (snapshot.email !== expectedNormalizedEmail) {
    throw userError('This encrypted backup belongs to a different inbox email namespace.', {
      code: 'BACKUP_NAMESPACE_MISMATCH',
    });
  }

  await importNamespaceKeyShareSnapshot({
    profile,
    secretStore,
    snapshot,
  });

  return {
    profile: profile.name,
    filePath: resolvedPath,
    email: snapshot.email,
    actorCount: countSharedActors(snapshot).toString(),
    keyVersionCount: countSharedKeyVersions(snapshot).toString(),
  };
}

export function defaultBackupFilePath(email: string): string {
  return path.resolve(buildNamespaceKeyBackupFileName(email));
}
