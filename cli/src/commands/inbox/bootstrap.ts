import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import { bootstrapInbox } from '../../services/inbox';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import { confirmYesNo, promptMultiline, promptText, waitForEnterMessage } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, green, renderKeyValue, yellow } from '../../services/render';

type BootstrapOptions = GlobalOptions & {
  displayName?: string;
  skipAgentRegistration?: boolean;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

export function registerInboxBootstrapCommand(command: Command): void {
  command
    .command('bootstrap')
    .description('Create or sync default inbox actor using current OIDC session')
    .option('--display-name <name>', 'Display name for the default inbox actor')
    .option('--skip-agent-registration', 'Skip managed inbox-agent registration after bootstrap')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as BootstrapOptions;
      await runCommandAction({
        title: 'Masumi inbox bootstrap',
        options,
        run: async ({ reporter }) =>
          bootstrapInbox({
            profileName: options.profile,
            displayName: options.displayName,
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
            confirmDefaultSlug: async ({ normalizedEmail, suggestedSlug }) => {
              const slug = await promptText({
                question: `Public inbox slug for ${normalizedEmail}`,
                defaultValue: suggestedSlug,
              });
              const selectedSlug = slug.trim() || suggestedSlug;
              const publicDescription = await promptMultiline({
                question: `Public description for /${selectedSlug} (optional).`,
                doneMessage: 'Press Enter on an empty line to skip or finish.',
              });
              return {
                slug: selectedSlug,
                publicDescription: publicDescription || null,
              };
            },
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
          summary: result.localKeysReady
            ? 'Inbox synced.'
            : yellow('Inbox synced. Local private keys still need recovery.'),
          details: renderKeyValue([
            { key: 'Email', value: result.inbox.displayEmail },
            { key: 'Slug', value: result.actor.slug, color: cyan },
            { key: 'Local keys', value: result.localKeysReady ? 'ready' : 'pending recovery', color: result.localKeysReady ? green : yellow },
          ]),
        }),
      });
    });
}
