import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { getPublicDescription, setPublicDescription } from '../../services/contact-management';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { renderEmptyWithTry, renderKeyValue, senderColor } from '../../services/render';

type PublicSetDescriptionOptions = GlobalOptions & {
  slug?: string;
  description?: string;
  file?: string;
};

async function resolveDescriptionInput(options: PublicSetDescriptionOptions): Promise<string | undefined> {
  if (options.description && options.file) {
    throw new Error('Choose either `--description` or `--file`, not both.');
  }

  if (options.file) {
    return await readFile(options.file, 'utf8');
  }

  return options.description;
}

export function registerInboxPublicCommand(command: Command): void {
  const publicCommand = command
    .command('public')
    .description('Manage public inbox-route metadata');

  publicCommand
    .command('show')
    .description('Show the public description exposed on /<slug>/public')
    .option('--slug <slug>', 'Owned inbox slug to inspect (defaults to the default slug)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as PublicSetDescriptionOptions;
      await runCommandAction({
        title: 'Masumi inbox public show',
        options,
        run: ({ reporter }) =>
          getPublicDescription({
            profileName: options.profile,
            reporter,
            actorSlug: options.slug,
          }),
        toHuman: result => ({
          summary: `Public description for ${senderColor(result.slug)}.`,
          details: result.description
            ? renderKeyValue([{ key: 'Description', value: result.description }])
            : [
                renderEmptyWithTry(
                  'No public description set.',
                  'masumi-agent-messenger inbox public set --description "<text>"'
                ),
              ],
        }),
      });
    });

  publicCommand
    .command('set')
    .description('Set or clear the public description exposed on /<slug>/public')
    .option('--slug <slug>', 'Owned inbox slug to update (defaults to the default slug)')
    .option('--description <text>', 'Description text to publish')
    .option('--file <path>', 'Read description text from a local file')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as PublicSetDescriptionOptions;
      await runCommandAction({
        title: 'Masumi inbox public set',
        options,
        run: async ({ reporter }) =>
          setPublicDescription({
            profileName: options.profile,
            reporter,
            actorSlug: options.slug,
            description: await resolveDescriptionInput(options),
          }),
        toHuman: result => ({
          summary: result.description
            ? `Updated public description for ${senderColor(result.slug)}.`
            : `Cleared public description for ${senderColor(result.slug)}.`,
          details: result.description
            ? [result.description]
            : [
                renderEmptyWithTry(
                  'No public description set.',
                  'masumi-agent-messenger inbox public set --description "<text>"'
                ),
              ],
        }),
      });
    });
}
