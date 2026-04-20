import type { Command } from 'commander';
import { getBirthdayCelebration } from '../../services/easter-eggs';
import {
  isPendingDeviceLoginResult,
  login,
  type AuthenticatedInboxResult,
  type PendingDeviceLoginResult,
} from '../../services/auth';
import { userError } from '../../services/errors';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { bold, cyan, green, renderKeyValue, yellow } from '../../services/render';
import {
  buildRegistrationPrompts,
  isInteractiveAuthFlow,
  maybeOfferAuthBackup,
  resolveRecoveryFlow,
  resolveRegistrationSettings,
  type AuthFlowOptions,
} from './shared';

type LoginResult = AuthenticatedInboxResult | PendingDeviceLoginResult;

export function registerAuthLoginCommand(command: Command): void {
  command
    .command('login')
    .description('Authenticate and bootstrap or recover your Masumi inbox')
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
      const options = commandInstance.optsWithGlobals() as AuthFlowOptions;
      if (!isInteractiveAuthFlow(options)) {
        throw userError(
          'Run `masumi-agent-messenger auth login` in an interactive terminal, or use `masumi-agent-messenger auth code start` / `masumi-agent-messenger auth code complete --polling-code <polling-code>`.',
          {
            code: 'AUTH_LOGIN_INTERACTIVE_REQUIRED',
          }
        );
      }

      const runtimeOptions: GlobalOptions = options.debug
        ? { ...options, verbose: true }
        : options;
      const prompts = buildRegistrationPrompts();

      await runCommandAction<LoginResult>({
        title: 'Masumi auth login',
        options: runtimeOptions,
        preferPlainReporter: false,
        run: async ({ reporter }) => {
          const registration = await resolveRegistrationSettings(options);
          let result = await login({
            profileName: options.profile,
            issuer: options.issuer,
            clientId: options.clientId,
            reporter,
            debug: options.debug,
            ...registration,
            ...prompts,
          });

          if (!options.json && result.recoveryRequired) {
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
          summary: isPendingDeviceLoginResult(result)
            ? 'Device authorization challenge ready.'
            : result.localKeysReady
              ? green('Authenticated and inbox synced.')
              : yellow('Authenticated, inbox synced. Local private keys still need recovery.'),
          details: isPendingDeviceLoginResult(result)
            ? renderKeyValue([
                { key: 'Device code', value: result.deviceCode, color: bold },
                { key: 'Verification URL', value: result.verificationUri },
                { key: 'Expires', value: result.expiresAt },
              ])
            : renderKeyValue([
                { key: 'Email', value: result.email ?? 'n/a' },
                { key: 'Slug', value: result.actor.slug, color: cyan },
                {
                  key: 'Local keys',
                  value: result.localKeysReady ? 'ready' : 'pending recovery',
                  color: result.localKeysReady ? green : yellow,
                },
                { key: 'Key source', value: result.keySource },
                ...(result.recoveryRequired
                  ? [
                      {
                        key: 'Recovery',
                        value: `${result.recoveryReason ?? 'required'} (${result.recoveryOptions.join(', ')})`,
                      },
                    ]
                  : []),
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
}
