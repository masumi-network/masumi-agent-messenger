import type { Command } from 'commander';
import {
  authStatus,
  isPendingDeviceLoginResult,
  login,
  logout,
  requestVerificationEmailForIssuer,
  startLogin,
  waitForLogin,
} from '../../services/auth';
import {
  approveDeviceShare,
  claimDeviceShare,
  listDevices,
  requestDeviceShare,
  revokeDeviceShareAccess,
} from '../../services/device';
import { userError } from '../../services/errors';
import { getBirthdayCelebration } from '../../services/easter-eggs';
import { formatRelativeTime } from '../../services/format';
import { bootstrapInbox } from '../../services/inbox';
import type { BootstrapResult } from '../../services/inbox-bootstrap';
import {
  backupInboxKeys,
  defaultBackupFilePath,
  restoreInboxKeys,
} from '../../services/key-backup';
import { loadProfile } from '../../services/config-store';
import {
  promptSecret,
  promptText,
} from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  badge,
  bold,
  cyan,
  dim,
  gray,
  green,
  renderKeyValue,
  renderTable,
  yellow,
  type TableColumn,
} from '../../services/render';
import { showCommandHelp } from '../menu';
import {
  buildAccountRegistrationPrompts,
  isInteractiveAccountFlow,
  maybeOfferAccountBackup,
  resolveAccountRecoveryFlow,
  resolveAccountRegistrationSettings,
  toRecoveredAccountResult,
  type AccountFlowOptions,
} from './shared';

type LoginResult = Awaited<ReturnType<typeof login>>;

type CompleteOptions = AccountFlowOptions & {
  code?: string;
};

type VerificationOptions = GlobalOptions & {
  email: string;
  issuer?: string;
  callbackUrl?: string;
};

type DeviceApproveOptions = GlobalOptions & {
  code?: string;
  deviceId?: string;
};

type DeviceRevokeOptions = GlobalOptions & {
  deviceId: string;
};

type BackupOptions = GlobalOptions & {
  file?: string;
  passphrase?: string;
};

function registerAccountLoginCommand(command: Command): void {
  const loginCommand = command
    .command('login')
    .description('Authenticate and bootstrap or recover your Masumi account');

  loginCommand
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client id')
    .option('--skip-agent-registration', 'Skip managed agent registration after bootstrap')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option(
      '--public-description <text>',
      'Public description to publish when registration runs automatically'
    )
    .option(
      '--public-description-file <path>',
      'Read the public description from a local file when registration runs automatically'
    )
    .option('--debug', 'Log full device authorization flow details')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AccountFlowOptions;
      if (!isInteractiveAccountFlow(options)) {
        throw userError(
          'Run `masumi-agent-messenger account login` in an interactive terminal, or use `masumi-agent-messenger account login start` / `masumi-agent-messenger account login complete --code <device-code>`.',
          {
            code: 'AUTH_LOGIN_INTERACTIVE_REQUIRED',
          }
        );
      }

      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;
      const prompts = buildAccountRegistrationPrompts();

      await runCommandAction<LoginResult>({
        title: 'Masumi account login',
        options: runtimeOptions,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const registration = await resolveAccountRegistrationSettings(options);
          let result = await login({
            profileName: options.profile,
            issuer: options.issuer,
            clientId: options.clientId,
            reporter,
            debug: options.debug,
            ...registration,
            ...prompts,
          });

          if (
            !options.json &&
            !isPendingDeviceLoginResult(result) &&
            result.recoveryRequired
          ) {
            result = await resolveAccountRecoveryFlow({
              result,
              options,
              reporter,
            });
          }

          if (!isPendingDeviceLoginResult(result)) {
            await maybeOfferAccountBackup({
              result,
              options,
              reporter,
              createdLabel: 'Your account inbox was created successfully.',
              rotatedLabel: 'New agent keys were created.',
            });
          }

          return result;
        },
        toHuman: result => ({
          summary: isPendingDeviceLoginResult(result)
            ? 'Device authorization challenge ready.'
            : result.localKeysReady
              ? green('Authenticated and account synced.')
              : yellow(
                  'Authenticated, account synced. Local private keys still need recovery.'
                ),
          details: isPendingDeviceLoginResult(result)
            ? renderKeyValue([
                { key: 'User code', value: result.userCode, color: bold },
                { key: 'Verification URL', value: result.verificationUri },
                { key: 'Expires', value: result.expiresAt },
              ])
            : renderKeyValue([
                { key: 'Email', value: result.email ?? 'n/a' },
                { key: 'Agent', value: result.actor.slug, color: cyan },
                {
                  key: 'Local keys',
                  value: result.localKeysReady ? 'ready' : 'pending recovery',
                  color: result.localKeysReady ? green : yellow,
                },
                { key: 'Key source', value: result.keySource },
              ]),
          celebration: isPendingDeviceLoginResult(result)
            ? undefined
            : (getBirthdayCelebration({
                email: result.inbox.displayEmail,
                displayName: result.actor.displayName,
              }) ?? undefined),
        }),
      });
    });

  loginCommand
    .command('start')
    .description('Start device authorization and print the challenge without waiting')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client id')
    .option('--debug', 'Log full device authorization flow details')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AccountFlowOptions;
      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;

      await runCommandAction({
        title: 'Masumi account login start',
        options: runtimeOptions,
        preferPlainReporter: Boolean(options.debug),
        run: ({ reporter }) =>
          startLogin({
            profileName: options.profile,
            issuer: options.issuer,
            clientId: options.clientId,
            reporter,
            debug: options.debug,
          }),
        toHuman: result => ({
          summary: 'Device authorization challenge ready.',
          details: renderKeyValue([
            { key: 'User code', value: result.userCode, color: bold },
            { key: 'Device code', value: result.deviceCode },
            { key: 'Verification URL', value: result.verificationUri },
            { key: 'Expires', value: result.expiresAt },
          ]),
        }),
      });
    });

  loginCommand
    .command('complete')
    .description('Finish a started device authorization with a device code')
    .option('--code <code>', 'Device authorization code to poll')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client id')
    .option('--skip-agent-registration', 'Skip managed agent registration after bootstrap')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option(
      '--public-description <text>',
      'Public description to publish when registration runs automatically'
    )
    .option(
      '--public-description-file <path>',
      'Read the public description from a local file when registration runs automatically'
    )
    .option('--debug', 'Log full device authorization flow details')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as CompleteOptions;
      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;
      const prompts = buildAccountRegistrationPrompts();

      await runCommandAction({
        title: 'Masumi account login complete',
        options: runtimeOptions,
        preferPlainReporter: Boolean(options.debug),
        run: async ({ reporter }) => {
          const deviceCode = options.code?.trim();
          if (!deviceCode) {
            throw userError('Device authorization code is required.', {
              code: 'DEVICE_CODE_REQUIRED',
            });
          }

          const registration = await resolveAccountRegistrationSettings(options);
          let result = await waitForLogin({
            profileName: options.profile,
            deviceCode,
            issuer: options.issuer,
            clientId: options.clientId,
            reporter,
            debug: options.debug,
            ...registration,
            ...prompts,
          });

          if (isInteractiveAccountFlow(options) && result.recoveryRequired) {
            result = await resolveAccountRecoveryFlow({
              result,
              options,
              reporter,
            });
          }

          await maybeOfferAccountBackup({
            result,
            options,
            reporter,
            createdLabel: 'Your account inbox was created successfully.',
            rotatedLabel: 'New agent keys were created.',
          });

          return result;
        },
        toHuman: result => ({
          summary: result.localKeysReady
            ? green('Logged in and account synced.')
            : yellow('Logged in, account synced. Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Email', value: result.email ?? 'n/a' },
            { key: 'Agent', value: result.actor.slug, color: cyan },
            {
              key: 'Local keys',
              value: result.localKeysReady ? 'ready' : 'pending recovery',
              color: result.localKeysReady ? green : yellow,
            },
          ]),
        }),
      });
    });
}

function registerAccountVerificationCommand(command: Command): void {
  const verification = command
    .command('verification')
    .description('Account email verification commands');

  verification.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  verification
    .command('resend')
    .description('Request a new verification email')
    .requiredOption('--email <email>', 'Email address that should receive the verification link')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--callback-url <url>', 'Verification callback URL to embed in the email')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as VerificationOptions;
      await runCommandAction({
        title: 'Masumi account verification resend',
        options,
        run: ({ reporter }) =>
          requestVerificationEmailForIssuer({
            profileName: options.profile,
            issuer: options.issuer,
            email: options.email,
            callbackURL: options.callbackUrl,
            reporter,
          }),
        toHuman: result => ({
          summary: result.sent
            ? green('Verification email requested.')
            : yellow('Verification email request failed.'),
          details: renderKeyValue([
            { key: 'Email', value: result.email },
            { key: 'Issuer', value: result.issuer, color: dim },
            ...(result.callbackURL
              ? [{ key: 'Callback URL', value: result.callbackURL, color: dim }]
              : []),
          ]),
        }),
      });
    });
}

function registerAccountDeviceCommands(command: Command): void {
  const device = command
    .command('device')
    .description('Device enrollment and key-sharing commands');

  device.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  device
    .command('request')
    .description(
      'Register a one-time encrypted key-share request and print the verification code. ' +
        'Run `masumi-agent-messenger account device claim` on this device after another trusted device approves the request.'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi account device request',
        options,
        run: ({ reporter }) =>
          requestDeviceShare({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => ({
          summary:
            'Device share request created. Run `masumi-agent-messenger account device claim` after approval.',
          details: renderKeyValue([
            { key: 'Verification code', value: result.verificationCode, color: bold },
            { key: 'Expires', value: formatRelativeTime(result.expiresAt), color: gray },
          ]),
        }),
      });
    });

  device
    .command('claim')
    .description('Import an approved one-time key share bundle on this device')
    .option(
      '--timeout <seconds>',
      'Seconds to wait for an approved bundle before giving up. Use 0 to return immediately.'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions & { timeout?: string };
      const timeoutSeconds =
        options.timeout !== undefined ? Number.parseInt(options.timeout, 10) : undefined;
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
        throw userError('Timeout must be a non-negative integer number of seconds.', {
          code: 'INVALID_DEVICE_CLAIM_TIMEOUT',
        });
      }

      await runCommandAction({
        title: 'Masumi account device claim',
        options,
        run: ({ reporter }) =>
          claimDeviceShare({
            profileName: options.profile,
            reporter,
            timeoutMs: timeoutSeconds !== undefined ? timeoutSeconds * 1_000 : undefined,
          }),
        toHuman: result => ({
          summary: result.imported
            ? green('Imported shared private keys.')
            : yellow(
                'No approved device share bundle was available before the claim window closed.'
              ),
          details: result.imported
            ? renderKeyValue([
                { key: 'Shared actors', value: String(result.sharedActorCount) },
                { key: 'Shared key versions', value: String(result.sharedKeyVersionCount) },
              ])
            : renderKeyValue([{ key: 'Device', value: result.deviceId, color: dim }]),
        }),
      });
    });

  device
    .command('approve')
    .description('Approve a pending one-time key share request')
    .option('--code <code>', 'Short-lived emoji verification code')
    .option('--device-id <id>', 'Target device id when approving the latest pending request')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as DeviceApproveOptions;
      await runCommandAction({
        title: 'Masumi account device approve',
        options,
        run: ({ reporter }) =>
          approveDeviceShare({
            profileName: options.profile,
            reporter,
            code: options.code,
            deviceId: options.deviceId,
          }),
        toHuman: result => ({
          summary: `Shared keys to device ${bold(result.deviceId)}.`,
          details: renderKeyValue([
            { key: 'Shared keys', value: String(result.sharedKeyVersionCount) },
            { key: 'Bundle expires', value: formatRelativeTime(result.expiresAt), color: gray },
          ]),
        }),
      });
    });

  device
    .command('list')
    .description('List enrolled devices for the current account')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi account device list',
        options,
        run: ({ reporter }) =>
          listDevices({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => {
          const columns: TableColumn[] = [
            { header: 'Device', key: 'name', color: bold },
            { header: 'Platform', key: 'platform', color: dim },
            { header: 'Status', key: 'status' },
            { header: 'Pending', key: 'pending' },
          ];
          return {
            summary: `${bold(String(result.devices.length))} device${
              result.devices.length === 1 ? '' : 's'
            } enrolled.`,
            details:
              result.devices.length === 0
                ? []
                : renderTable(
                    result.devices.map(deviceItem => ({
                      name: deviceItem.label ?? deviceItem.deviceId,
                      platform: deviceItem.platform ?? '',
                      status:
                        deviceItem.status === 'active'
                          ? badge('active', green)
                          : badge(deviceItem.status, yellow),
                      pending:
                        deviceItem.pendingRequestCount > 0
                          ? badge(`${deviceItem.pendingRequestCount} pending`, yellow)
                          : '',
                    })),
                    columns
                  ),
          };
        },
      });
    });

  device
    .command('revoke')
    .description('Revoke a device from future one-time key shares')
    .requiredOption('--device-id <id>', 'Device id to revoke')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as DeviceRevokeOptions;
      await runCommandAction({
        title: 'Masumi account device revoke',
        options,
        run: ({ reporter }) =>
          revokeDeviceShareAccess({
            profileName: options.profile,
            deviceId: options.deviceId,
            reporter,
          }),
        toHuman: result => ({
          summary: `Revoked device ${result.deviceId}.`,
          details: renderKeyValue([{ key: 'Profile', value: result.profile, color: dim }]),
        }),
      });
    });
}

function registerAccountBackupCommands(command: Command): void {
  const backup = command
    .command('backup')
    .description('Encrypted agent-key backup commands');

  backup.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  backup
    .command('export')
    .description('Export an encrypted backup of local private keys')
    .option('--file <path>', 'Path to write the encrypted backup file')
    .option('--passphrase <text>', 'Backup passphrase (avoid shell history when possible)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as BackupOptions;
      await runCommandAction({
        title: 'Masumi account backup export',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const profile = await loadProfile(options.profile);
          const normalizedEmail =
            profile.bootstrapSnapshot?.inbox.normalizedEmail ?? 'masumi-agent-messenger';
          const filePath =
            options.file ??
            (options.json
              ? defaultBackupFilePath(normalizedEmail)
              : await promptText({
                  question: 'Backup file path',
                  defaultValue: defaultBackupFilePath(normalizedEmail),
                }));
          const passphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Backup passphrase',
            }));
          const confirmPassphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Confirm backup passphrase',
            }));

          if (!passphrase.trim()) {
            throw userError('Backup passphrase is required.', {
              code: 'BACKUP_PASSPHRASE_REQUIRED',
            });
          }
          if (passphrase !== confirmPassphrase) {
            throw userError('Backup passphrases do not match.', {
              code: 'BACKUP_PASSPHRASE_MISMATCH',
            });
          }

          return backupInboxKeys({
            profileName: options.profile,
            filePath,
            passphrase,
            reporter,
          });
        },
        toHuman: result => ({
          summary: 'Encrypted key backup created.',
          details: renderKeyValue([
            { key: 'File', value: result.filePath },
            { key: 'Email', value: result.normalizedEmail },
            { key: 'Agents', value: result.actorCount },
            { key: 'Key versions', value: result.keyVersionCount },
          ]),
        }),
      });
    });

  backup
    .command('import')
    .description('Import an encrypted backup of local private keys')
    .option('--file <path>', 'Path to the encrypted backup file')
    .option('--passphrase <text>', 'Backup passphrase (avoid shell history when possible)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as BackupOptions;
      await runCommandAction({
        title: 'Masumi account backup import',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const filePath =
            options.file ??
            (await promptText({
              question: 'Encrypted backup file path',
            }));
          const passphrase =
            options.passphrase ??
            (await promptSecret({
              question: 'Backup passphrase',
            }));

          if (!filePath.trim()) {
            throw userError('Encrypted backup file path is required.', {
              code: 'BACKUP_FILE_REQUIRED',
            });
          }
          if (!passphrase.trim()) {
            throw userError('Backup passphrase is required.', {
              code: 'BACKUP_PASSPHRASE_REQUIRED',
            });
          }

          return restoreInboxKeys({
            profileName: options.profile,
            filePath,
            passphrase,
            reporter,
          });
        },
        toHuman: result => ({
          summary: 'Encrypted key backup imported.',
          details: renderKeyValue([
            { key: 'File', value: result.filePath },
            { key: 'Email', value: result.normalizedEmail },
            { key: 'Agents', value: result.actorCount },
            { key: 'Key versions', value: result.keyVersionCount },
          ]),
        }),
      });
    });
}

export function registerAccountCommands(program: Command): void {
  const account = program
    .command('account')
    .description('Account authentication, recovery, device, and backup commands');

  account.action((_options, commandInstance) => {
    showCommandHelp(commandInstance);
  });

  registerAccountLoginCommand(account);
  registerAccountVerificationCommand(account);
  registerAccountDeviceCommands(account);
  registerAccountBackupCommands(account);

  account
    .command('status')
    .description('Show local account session status')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi account status',
        options,
        run: ({ reporter }) =>
          authStatus({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => ({
          summary: result.authenticated
            ? `Signed in as ${cyan(result.email ?? result.subject ?? 'unknown')}.`
            : yellow('Not signed in.'),
          details: result.authenticated
            ? renderKeyValue([
                { key: 'Profile', value: result.profile, color: dim },
                { key: 'Issuer', value: result.issuer ?? 'n/a', color: dim },
              ])
            : renderKeyValue([{ key: 'Profile', value: result.profile, color: dim }]),
        }),
      });
    });

  account
    .command('sync')
    .description('Create or resync the default agent using the current OIDC session')
    .option('--skip-agent-registration', 'Skip managed agent registration during sync')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option(
      '--public-description <text>',
      'Public description to publish when registration runs automatically'
    )
    .option(
      '--public-description-file <path>',
      'Read the public description from a local file when registration runs automatically'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AccountFlowOptions;
      const prompts = buildAccountRegistrationPrompts();

      await runCommandAction<BootstrapResult>({
        title: 'Masumi account sync',
        options,
        run: async ({ reporter }) => {
          const registration = await resolveAccountRegistrationSettings(options);
          let result = await bootstrapInbox({
            profileName: options.profile,
            reporter,
            ...registration,
            ...prompts,
          });

          if (isInteractiveAccountFlow(options) && result.recoveryRequired) {
            result = await resolveAccountRecoveryFlow({
              result: toRecoveredAccountResult(result),
              options,
              reporter,
            });
          }

          await maybeOfferAccountBackup({
            result: toRecoveredAccountResult(result),
            options,
            reporter,
            createdLabel: 'Your account inbox was created successfully.',
            rotatedLabel: 'New agent keys were created.',
          });

          return result;
        },
        toHuman: result => ({
          summary: result.localKeysReady
            ? green('Account synced.')
            : yellow('Account synced. Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Email', value: result.inbox.displayEmail },
            { key: 'Agent', value: result.actor.slug, color: cyan },
            {
              key: 'Local keys',
              value: result.localKeysReady ? 'ready' : 'pending recovery',
              color: result.localKeysReady ? green : yellow,
            },
          ]),
        }),
      });
    });

  account
    .command('recover')
    .description('Guide key recovery for the current authenticated profile')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AccountFlowOptions;
      if (!isInteractiveAccountFlow(options)) {
        throw userError(
          'Run `masumi-agent-messenger account recover` in an interactive terminal, or use `masumi-agent-messenger account device`, `masumi-agent-messenger account backup import`, or `masumi-agent-messenger agent key rotate` directly.',
          {
            code: 'AUTH_RECOVER_INTERACTIVE_REQUIRED',
          }
        );
      }

      const prompts = buildAccountRegistrationPrompts();
      await runCommandAction({
        title: 'Masumi account recover',
        options,
        run: async ({ reporter }) => {
          const registration = await resolveAccountRegistrationSettings(options);
          const result = await bootstrapInbox({
            profileName: options.profile,
            reporter,
            ...registration,
            ...prompts,
          });

          if (!result.recoveryRequired) {
            return result;
          }

          return resolveAccountRecoveryFlow({
            result: toRecoveredAccountResult(result),
            options,
            reporter,
          });
        },
        toHuman: result => ({
          summary: result.localKeysReady
            ? green('Local private keys are ready.')
            : yellow('Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Agent', value: result.actor.slug },
            { key: 'Key source', value: result.keySource },
            {
              key: 'Recovery',
              value: result.recoveryRequired
                ? `${result.recoveryReason ?? 'required'} (${result.recoveryOptions.join(', ')})`
                : 'not required',
            },
          ]),
        }),
      });
    });

  account
    .command('logout')
    .description('Clear local account session (keeps private keys)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as GlobalOptions;
      await runCommandAction({
        title: 'Masumi account logout',
        options,
        run: ({ reporter }) =>
          logout({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => ({
          summary: 'Signed out.',
          details: renderKeyValue([{ key: 'Profile', value: result.profile, color: dim }]),
        }),
      });
    });
}
