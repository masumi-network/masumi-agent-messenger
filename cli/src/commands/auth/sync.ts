import type { Command } from 'commander';
import { getBirthdayCelebration } from '../../services/easter-eggs';
import { bootstrapInbox } from '../../services/inbox';
import { runCommandAction } from '../../services/command-runtime';
import { cyan, green, renderKeyValue, yellow } from '../../services/render';
import {
  buildRegistrationPrompts,
  isInteractiveAuthFlow,
  maybeOfferAuthBackup,
  resolveRecoveryFlow,
  resolveRegistrationSettings,
  toRecoveredAuthResult,
  type AuthFlowOptions,
} from './shared';

export function registerAuthSyncCommand(command: Command): void {
  command
    .command('sync')
    .description('Create or resync the default inbox using the current OIDC session')
    .option('--skip-agent-registration', 'Skip managed inbox-agent registration during sync')
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
      const options = commandInstance.optsWithGlobals() as AuthFlowOptions;
      const prompts = buildRegistrationPrompts();

      await runCommandAction({
        title: 'Masumi auth sync',
        options,
        run: async ({ reporter }) => {
          const registration = await resolveRegistrationSettings(options);
          let result = await bootstrapInbox({
            profileName: options.profile,
            reporter,
            ...registration,
            ...prompts,
          });

          if (isInteractiveAuthFlow(options) && result.recoveryRequired) {
            result = await resolveRecoveryFlow({
              result: toRecoveredAuthResult(result),
              options,
              reporter,
            });
          }

          await maybeOfferAuthBackup({
            result: toRecoveredAuthResult(result),
            options,
            reporter,
            createdLabel: 'Your inbox was created successfully.',
            rotatedLabel: 'New inbox keys were created.',
          });

          return result;
        },
        toHuman: result => ({
          summary: result.localKeysReady
            ? green('Inbox synced.')
            : yellow('Inbox synced. Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Email', value: result.inbox.displayEmail },
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
