import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import { createInboxIdentity } from '../../services/inbox-management';
import { userError } from '../../services/errors';
import { maybeOfferBackupAfterKeyCreation } from '../../services/key-backup-prompt';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import { confirmYesNo, promptMultiline, waitForEnterMessage } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, dim, green, renderKeyValue, yellow } from '../../services/render';
import { isInteractiveHumanMode } from '../menu';

type CreateOptions = GlobalOptions & {
  slug?: string;
  displayName?: string;
  skipAgentRegistration?: boolean;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

export function registerInboxCreateCommand(command: Command): void {
  command
    .command('create')
    .description('Create a non-default inbox slug in your owned namespace')
    .argument('[slug]', 'Inbox slug to create')
    .option('--slug <slug>', 'Inbox slug to create')
    .option('--display-name <name>', 'Optional inbox display name')
    .option('--skip-agent-registration', 'Skip managed inbox-agent registration after creation')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async function (this: Command, slugArg: string | undefined) {
      const options = this.optsWithGlobals() as CreateOptions;
      const slug = slugArg?.trim() || options.slug?.trim();
      if (!slug) {
        throw userError('Inbox slug is required.', {
          code: 'INBOX_SLUG_REQUIRED',
        });
      }
      await runCommandAction({
        title: 'Masumi inbox create',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) =>
          createInboxIdentity({
            profileName: options.profile,
            slug,
            displayName: options.displayName,
            reporter,
            registrationMode: options.skipAgentRegistration
              ? 'skip'
              : isInteractiveHumanMode(options)
                ? 'prompt'
                : 'auto',
            desiredLinkedEmailVisibility: !options.disableLinkedEmail,
            desiredPublicDescription: await resolvePublicDescriptionOption({
              description: options.publicDescription,
              descriptionFile: options.publicDescriptionFile,
            }),
            confirmRegistration: async ({ actorSlug, displayName, creditsRemaining }) =>
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
          }).then(async result => {
            if (!options.json) {
              await maybeOfferBackupAfterKeyCreation({
                profileName: options.profile,
                reporter,
                promptLabel: `Inbox slug ${result.actor.slug} was created successfully.`,
              });
            }
            return result;
          }),
        toHuman: result => ({
          summary: `Created slug ${cyan(result.actor.slug)}.`,
          details: renderKeyValue([
            ...(result.actor.displayName
              ? [{ key: 'Display name', value: result.actor.displayName }]
              : []),
            {
              key: 'Agent',
              value: result.registration.status,
              color: result.registration.status === 'registered' ? green : yellow,
            },
            ...(result.registration.agentIdentifier
              ? [{ key: 'Agent ID', value: result.registration.agentIdentifier, color: dim }]
              : []),
            ...(result.registration.creditsRemaining !== null &&
            result.registration.creditsRemaining !== undefined
              ? [{ key: 'Credits', value: String(result.registration.creditsRemaining) }]
              : []),
            ...(result.registration.error
              ? [{ key: 'Registration note', value: result.registration.error, color: yellow }]
              : []),
          ]),
        }),
      });
    });
}
