import type { Command } from 'commander';
import { authStatus } from '../../services/auth';
import type { BootstrapSnapshot } from '../../services/config-store';
import { loadProfile } from '../../services/config-store';
import { createSecretStore } from '../../services/secret-store';
import type { GlobalOptions } from '../../services/command-runtime';
import { loadCurrentBootstrapSnapshot } from '../../services/inbox';
import { promptText } from '../../services/prompts';
import { registerAuthBackupCommands } from './backup';
import { registerAuthCodeCommands } from './code';
import { registerAuthDeviceCommands } from './device';
import { registerAuthLoginCommand } from './login';
import { registerAuthLogoutCommand } from './logout';
import { registerAuthKeysRemoveCommand } from './keys-remove';
import { registerAuthRecoverCommand } from './recover';
import { registerAuthSendVerificationEmailCommand } from './send-verification-email';
import { registerAuthStatusCommand } from './status';
import { registerAuthSyncCommand } from './sync';
import { registerAuthRotateCommand } from '../inbox/rotate-keys';
import {
  chooseMenuAction,
  invokeMenuCommand,
  isInteractiveHumanMode,
  showCommandHelp,
} from '../menu';

type AuthMenuMode = 'signed_out' | 'healthy' | 'recovery';

function silentReporter() {
  return {
    info() {},
    success() {},
    verbose() {},
  };
}

function snapshotKeysRequireRecovery(
  snapshot: BootstrapSnapshot | undefined,
  keyPair: Awaited<ReturnType<ReturnType<typeof createSecretStore>['getAgentKeyPair']>>
): boolean {
  if (!snapshot || !keyPair) {
    return false;
  }

  if (
    snapshot.keyVersions.encryption !== keyPair.encryption.keyVersion ||
    snapshot.keyVersions.signing !== keyPair.signing.keyVersion
  ) {
    return true;
  }

  if (!snapshot.actorKeys) {
    return false;
  }

  return (
    snapshot.actorKeys.encryption.publicKey !== keyPair.encryption.publicKey ||
    snapshot.actorKeys.encryption.keyVersion !== keyPair.encryption.keyVersion ||
    snapshot.actorKeys.signing.publicKey !== keyPair.signing.publicKey ||
    snapshot.actorKeys.signing.keyVersion !== keyPair.signing.keyVersion
  );
}

async function inferAuthMenuMode(profileName: string): Promise<AuthMenuMode> {
  const status = await authStatus({
    profileName,
    reporter: silentReporter(),
  });
  if (!status.authenticated) {
    return 'signed_out';
  }

  const profile = await loadProfile(profileName);
  const secretStore = createSecretStore();
  const keyPair = await secretStore.getAgentKeyPair(profile.name);
  const namespaceVault = await secretStore.getNamespaceKeyVault(profile.name);

  if (profile.bootstrapSnapshot && (!keyPair || !namespaceVault)) {
    return 'recovery';
  }

  if (snapshotKeysRequireRecovery(profile.bootstrapSnapshot, keyPair)) {
    return 'recovery';
  }

  if (profile.bootstrapSnapshot && !profile.bootstrapSnapshot.actorKeys) {
    const liveSnapshot = await loadCurrentBootstrapSnapshot({
      profileName,
      reporter: silentReporter(),
    }).catch(() => null);
    if (snapshotKeysRequireRecovery(liveSnapshot ?? undefined, keyPair)) {
      return 'recovery';
    }
  }

  return 'healthy';
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication, recovery, and key management commands');

  auth.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    if (!isInteractiveHumanMode(options)) {
      showCommandHelp(commandInstance);
      return;
    }

    const mode = await inferAuthMenuMode(options.profile);

    if (mode === 'signed_out') {
      const choice = await chooseMenuAction({
        question: 'How do you want to continue?',
        defaultValue: 'login',
        options: [
          { value: 'login', label: 'Sign in' },
          { value: 'resend-verification', label: 'Resend verification email' },
          { value: 'status', label: 'Show auth status' },
        ],
      });

      if (choice === 'resend-verification') {
        const email = await promptText({
          question: 'Email address that should receive the verification link',
        });
        await invokeMenuCommand(options, ['auth', 'resend-verification', '--email', email]);
        return;
      }

      await invokeMenuCommand(options, ['auth', choice]);
      return;
    }

    const choice = await chooseMenuAction({
      question: 'How do you want to continue?',
      defaultValue: mode === 'recovery' ? 'recover' : 'status',
      options:
        mode === 'recovery'
          ? [
              { value: 'recover', label: 'Recover private keys' },
              { value: 'device', label: 'Open device commands' },
              { value: 'backup', label: 'Open backup commands' },
              { value: 'rotate', label: 'Rotate inbox keys' },
              { value: 'keys-remove', label: 'Remove local keys' },
              { value: 'logout', label: 'Sign out' },
            ]
          : [
              { value: 'status', label: 'Show auth status' },
              { value: 'sync', label: 'Resync the default inbox' },
              { value: 'device', label: 'Open device commands' },
              { value: 'backup', label: 'Open backup commands' },
              { value: 'rotate', label: 'Rotate inbox keys' },
              { value: 'keys-remove', label: 'Remove local keys' },
              { value: 'logout', label: 'Sign out' },
            ],
    });

    await invokeMenuCommand(options, ['auth', choice]);
  });

  registerAuthLoginCommand(auth);
  registerAuthCodeCommands(auth);
  registerAuthSendVerificationEmailCommand(auth);
  registerAuthSyncCommand(auth);
  registerAuthRecoverCommand(auth);
  registerAuthDeviceCommands(auth);
  registerAuthBackupCommands(auth);
  registerAuthRotateCommand(auth);
  registerAuthStatusCommand(auth);
  registerAuthLogoutCommand(auth);
  registerAuthKeysRemoveCommand(auth);
}
