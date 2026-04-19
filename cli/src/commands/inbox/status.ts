import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import { inboxStatus } from '../../services/inbox';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import { confirmYesNo, promptMultiline, waitForEnterMessage } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { bold, cyan, dim, green, renderKeyValue, yellow } from '../../services/render';

type StatusOptions = GlobalOptions & {
  skipAgentRegistration?: boolean;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

export function registerInboxStatusCommand(command: Command): void {
  command
    .command('status')
    .description('Show live inbox bootstrap status')
    .option('--skip-agent-registration', 'Skip managed inbox-agent registration during status sync')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as StatusOptions;
      await runCommandAction({
        title: 'Masumi inbox status',
        options,
        run: async ({ reporter }) =>
          inboxStatus({
            profileName: options.profile,
            reporter,
            registrationMode: options.skipAgentRegistration
              ? 'skip'
              : options.json
                ? 'auto'
                : 'prompt',
            desiredLinkedEmailVisibility: !options.disableLinkedEmail,
            desiredPublicDescription: await resolvePublicDescriptionOption({
              description: options.publicDescription,
              descriptionFile: options.publicDescriptionFile,
            }),
            confirmAgentRegistration: async ({ actorSlug, displayName, creditsRemaining }) =>
              confirmYesNo({
                question: `Create managed inbox agent for ${displayName ?? actorSlug} on ${getMasumiInboxAgentNetwork()}? Credits: ${creditsRemaining ?? 'unknown'}.`,
                defaultValue: true,
              }),
            confirmLinkedEmailVisibility: async ({ actorSlug }) =>
              confirmYesNo({
                question: `Expose linked email on /${actorSlug}/public?`,
                defaultValue: true,
              }),
            confirmPublicDescription: async ({ actorSlug }) => {
              const shouldSetDescription = await confirmYesNo({
                question: `Set a public description on /${actorSlug}/public now?`,
                defaultValue: false,
              });
              if (!shouldSetDescription) {
                return null;
              }
              const description = await promptMultiline({
                question: 'Enter the public description markdown.',
              });
              return description || null;
            },
            pauseAfterRegistrationBlocked: async message => {
              await waitForEnterMessage(`${message} Press Enter to continue.`);
            },
          }),
        toHuman: result => ({
          summary: result.connected
            ? `Inbox active as ${cyan(result.actor?.slug ?? 'unknown')}.`
            : result.authenticated
              ? yellow('Signed in, but inbox is not connected.')
              : yellow('Not signed in.'),
          details: result.connected
            ? renderKeyValue([
                { key: 'Slug', value: result.actor?.slug ?? 'n/a', color: bold },
                { key: 'Agent', value: result.agentRegistration.status, color: result.agentRegistration.status === 'registered' ? green : yellow },
                ...(result.agentRegistration.agentIdentifier
                  ? [{ key: 'Agent ID', value: result.agentRegistration.agentIdentifier, color: dim }]
                  : []),
              ])
            : renderKeyValue([{ key: 'Profile', value: result.profile }]),
        }),
      });
    });
}
