import type { Command } from 'commander';
import { userError } from '../../services/errors';
import { bootstrapInbox } from '../../services/inbox';
import { runCommandAction } from '../../services/command-runtime';
import { green, renderKeyValue, yellow } from '../../services/render';
import {
  buildRegistrationPrompts,
  isInteractiveAuthFlow,
  resolveRecoveryFlow,
  resolveRegistrationSettings,
  toRecoveredAuthResult,
  type AuthFlowOptions,
} from './shared';

export function registerAuthRecoverCommand(command: Command): void {
  command
    .command('recover')
    .description('Guide key recovery for the current authenticated profile')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AuthFlowOptions;
      if (!isInteractiveAuthFlow(options)) {
        throw userError(
          'Run `masumi-agent-messenger auth recover` in an interactive terminal, or use `masumi-agent-messenger auth device`, `masumi-agent-messenger auth backup import`, or `masumi-agent-messenger auth rotate` directly.',
          {
            code: 'AUTH_RECOVER_INTERACTIVE_REQUIRED',
          }
        );
      }

      const prompts = buildRegistrationPrompts();
      await runCommandAction({
        title: 'Masumi auth recover',
        options,
        run: async ({ reporter }) => {
          const registration = await resolveRegistrationSettings(options);
          const result = await bootstrapInbox({
            profileName: options.profile,
            reporter,
            ...registration,
            ...prompts,
          });

          if (!result.recoveryRequired) {
            return result;
          }

          return resolveRecoveryFlow({
            result: toRecoveredAuthResult(result),
            options,
            reporter,
          });
        },
        toHuman: result => ({
          summary: result.localKeysReady
            ? green('Local private keys are ready.')
            : yellow('Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Slug', value: result.actor.slug },
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
}
