import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import { deregisterInboxAgent } from '../../services/inbox-management';
import { userError } from '../../services/errors';
import { confirmYesNo } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, dim, green, renderKeyValue, yellow } from '../../services/render';

type DeregisterAgentOptions = GlobalOptions & {
  slug?: string;
  yes?: boolean;
};

export function registerInboxAgentDeregisterCommand(command: Command): void {
  command
    .command('deregister')
    .description('Deregister a managed Masumi inbox-agent for one of your inbox slugs')
    .option('--slug <slug>', 'Owned inbox slug to deregister')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as DeregisterAgentOptions;
      await runCommandAction({
        title: 'Masumi inbox agent deregister',
        options,
        run: async ({ reporter }) => {
          if (!options.json && !options.yes) {
            const confirmed = await confirmYesNo({
              question: `Deregister this managed inbox agent on ${getMasumiInboxAgentNetwork()}?`,
              defaultValue: false,
            });
            if (!confirmed) {
              throw userError('Deregistration cancelled.', {
                code: 'DEREGISTRATION_CANCELLED',
              });
            }
          }

          return deregisterInboxAgent({
            profileName: options.profile,
            actorSlug: options.slug,
            reporter,
          });
        },
        toHuman: result => ({
          summary:
            result.registration.registrationState === 'DeregistrationConfirmed'
              ? green('Managed agent is deregistered.')
              : yellow(`Managed agent status: ${result.registration.status}.`),
          details: renderKeyValue([
            { key: 'Slug', value: result.actor.slug, color: cyan },
            ...(result.registration.inboxAgentId
              ? [{ key: 'Inbox agent', value: result.registration.inboxAgentId, color: dim }]
              : []),
            ...(result.registration.registrationState
              ? [{ key: 'State', value: result.registration.registrationState, color: dim }]
              : []),
          ]),
        }),
      });
    });
}
