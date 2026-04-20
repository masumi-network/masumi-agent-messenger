import type { Command } from 'commander';
import { getBirthdayCelebration } from '../../services/easter-eggs';
import { startLogin, waitForLogin } from '../../services/auth';
import { userError } from '../../services/errors';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { bold, cyan, green, red, renderKeyValue, yellow } from '../../services/render';
import {
  buildRegistrationPrompts,
  isInteractiveAuthFlow,
  maybeOfferAuthBackup,
  resolveRecoveryFlow,
  resolveRegistrationSettings,
  type AuthFlowOptions,
} from './shared';

type CompleteOptions = AuthFlowOptions & {
  pollingCode?: string;
};

function registerAuthCodeStartCommand(command: Command): void {
  command
    .command('start')
    .description('Start device authorization and print the challenge without waiting')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client id')
    .option('--debug', 'Log full device authorization flow details')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AuthFlowOptions;
      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;

      await runCommandAction({
        title: 'Masumi auth code start',
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
            { key: 'Device code', value: result.deviceCode, color: bold },
            { key: 'Polling code', value: result.pollingCode },
            { key: 'Verification URL', value: result.verificationUri },
            { key: 'Expires', value: result.expiresAt },
          ]),
        }),
      });
    });
}

function registerAuthCodeCompleteCommand(command: Command): void {
  command
    .command('complete')
    .description('Finish a started device authorization with a polling code')
    .option('--polling-code <code>', 'Polling code returned by `auth code start`')
    .option('--issuer <url>', 'OIDC issuer URL')
    .option('--client-id <id>', 'OIDC client id')
    .option('--skip-agent-registration', 'Skip managed inbox-agent registration after bootstrap')
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
      const pollingCode = options.pollingCode?.trim();

      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;
      const prompts = buildRegistrationPrompts();

      await runCommandAction({
        title: 'Masumi auth code complete',
        options: runtimeOptions,
        preferPlainReporter: Boolean(options.debug),
        run: async ({ reporter }) => {
          if (!pollingCode) {
            throw userError('Polling code is required.', {
              code: 'POLLING_CODE_REQUIRED',
            });
          }

          const registration = await resolveRegistrationSettings(options);
          let result = await waitForLogin({
            profileName: options.profile,
            pollingCode,
            issuer: options.issuer,
            clientId: options.clientId,
            reporter,
            debug: options.debug,
            ...registration,
            ...prompts,
          });

          if (isInteractiveAuthFlow(options) && result.recoveryRequired) {
            result = await resolveRecoveryFlow({
              result,
              options,
              reporter,
            });
          }

          await maybeOfferAuthBackup({
            result,
            options,
            reporter,
            createdLabel: 'Your inbox was created successfully.',
            rotatedLabel: 'New inbox keys were created.',
          });

          return result;
        },
        toHuman: result => ({
          summary: result.authenticated
            ? result.localKeysReady
              ? green('Logged in and inbox synced.')
              : yellow('Logged in, inbox synced. Local private keys still need recovery.')
            : red('Authentication failed.'),
          details: renderKeyValue([
            { key: 'Email', value: result.email ?? 'n/a' },
            { key: 'Slug', value: result.actor.slug, color: cyan },
            {
              key: 'Local keys',
              value: result.localKeysReady ? 'ready' : 'pending recovery',
              color: result.localKeysReady ? green : yellow,
            },
          ]),
          celebration:
            getBirthdayCelebration({
              email: result.inbox.displayEmail,
              displayName: result.actor.displayName,
            }) ?? undefined,
        }),
      });
    });
}

export function registerAuthCodeCommands(command: Command): void {
  const code = command
    .command('code')
    .description('Device-code authentication commands for scripts and agents');

  registerAuthCodeStartCommand(code);
  registerAuthCodeCompleteCommand(code);
}
