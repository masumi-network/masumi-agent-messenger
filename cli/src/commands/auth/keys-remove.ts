import type { Command } from 'commander';
import { removeLocalKeys } from '../../services/auth';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { dim, renderKeyValue } from '../../services/render';
import { confirmYesNo } from '../../services/prompts';
import { userError } from '../../services/errors';

type KeysRemoveOptions = GlobalOptions & {
  yes?: boolean;
};

export function registerAuthKeysRemoveCommand(command: Command): void {
  command
    .command('keys-remove')
    .description('Remove local device keys (dangerous, also signs out)')
    .option('--yes', 'Skip confirmation and remove local keys (dangerous)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as KeysRemoveOptions;

      await runCommandAction({
        title: 'Masumi auth keys-remove',
        options,
        run: ({ reporter }) =>
          (async () => {
            if (!options.json && !options.yes) {
              const confirmed = await confirmYesNo({
                defaultValue: false,
                question:
                  'This wipes local key material for this profile, including:\n' +
                  '- Local agent key bundle\n' +
                  '- Local device key material\n' +
                  '- Local namespace key vault\n' +
                  '- Stored profile bootstrap state\n\n' +
                  'It also signs you out by removing the local OIDC session.\n\n' +
                  'Continue?',
              });

              if (!confirmed) {
                throw userError('Key removal cancelled.', { code: 'AUTH_KEYS_REMOVE_CANCELLED' });
              }
            }

            return removeLocalKeys({
              profileName: options.profile,
              reporter,
            });
          })(),
        toHuman: result => ({
          summary: 'Local keys removed.',
          details: renderKeyValue([
            { key: 'Profile', value: result.profile, color: dim },
            { key: 'Status', value: 'signed out', color: dim },
          ]),
        }),
      });
    });
}

