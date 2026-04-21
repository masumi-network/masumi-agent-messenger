import type { Command } from 'commander';
import {
  confirmCurrentImportedRotationKey,
  type ConfirmCurrentImportedRotationKeyResult,
} from '../../services/imported-rotation-key-confirmation';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { dim, renderKeyValue } from '../../services/render';

type KeysConfirmOptions = GlobalOptions & {
  slug?: string;
};

function describePreviousStatus(result: ConfirmCurrentImportedRotationKeyResult): string {
  if (result.previousStatus === 'pending') {
    return 'confirmed';
  }
  if (result.previousStatus === 'confirmed') {
    return 'already confirmed';
  }
  return 'no pending import found';
}

export function registerAuthKeysConfirmCommand(command: Command): void {
  const keys = command.command('keys').description('Local key confirmation commands');
  keys
    .command('confirm')
    .description('Confirm automatically imported rotated private keys before sending')
    .option('--slug <slug>', 'Inbox slug to confirm')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as KeysConfirmOptions;

      await runCommandAction({
        title: 'Masumi auth keys confirm',
        options,
        run: () =>
          confirmCurrentImportedRotationKey({
            profileName: options.profile,
            actorSlug: options.slug,
          }),
        toHuman: result => ({
          summary:
            result.previousStatus === 'pending'
              ? 'Imported rotated keys confirmed.'
              : 'Imported rotated keys checked.',
          details: renderKeyValue([
            { key: 'Profile', value: result.profile, color: dim },
            { key: 'Inbox', value: result.slug },
            { key: 'Status', value: describePreviousStatus(result), color: dim },
          ]),
        }),
      });
    });
}
