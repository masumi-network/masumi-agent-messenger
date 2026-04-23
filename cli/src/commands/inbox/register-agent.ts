import type { Command } from 'commander';
import { getMasumiInboxAgentNetwork } from '../../../../shared/inbox-agent-registration';
import { registerInboxAgent } from '../../services/inbox-management';
import { resolvePublicDescriptionOption } from '../../services/public-description';
import { confirmYesNo, promptMultiline, waitForEnterMessage } from '../../services/prompts';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, dim, green, renderKeyValue, yellow } from '../../services/render';
import { isInteractiveHumanMode } from '../menu';

type RegisterAgentOptions = GlobalOptions & {
  slug?: string;
  disableLinkedEmail?: boolean;
  publicDescription?: string;
  publicDescriptionFile?: string;
};

export function registerInboxAgentRegisterCommand(command: Command): void {
  command
    .command('register')
    .description('Register or sync a managed Masumi inbox-agent for one of your inbox slugs')
    .option('--slug <slug>', 'Owned inbox slug to register or sync')
    .option(
      '--disable-linked-email',
      'Disable linked email exposure when registration runs automatically'
    )
    .option('--public-description <text>', 'Public description to publish when registration runs automatically')
    .option('--public-description-file <path>', 'Read the public description from a local file when registration runs automatically')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as RegisterAgentOptions;
      await runCommandAction({
        title: 'Masumi inbox agent register',
        options,
        run: async ({ reporter }) =>
          registerInboxAgent({
            profileName: options.profile,
            actorSlug: options.slug,
            reporter,
            registrationMode: isInteractiveHumanMode(options) ? 'prompt' : 'auto',
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
          }),
        toHuman: result => ({
          summary: `Agent status: ${result.registration.status === 'registered' ? green(result.registration.status) : yellow(result.registration.status)}.`,
          details: renderKeyValue([
            { key: 'Slug', value: result.actor.slug, color: cyan },
            ...(result.registration.agentIdentifier
              ? [{ key: 'Agent ID', value: result.registration.agentIdentifier, color: dim }]
              : []),
            ...(result.registration.creditsRemaining !== null &&
            result.registration.creditsRemaining !== undefined
              ? [{ key: 'Credits', value: String(result.registration.creditsRemaining) }]
              : []),
          ]),
        }),
      });
    });
}
