import type { Command } from 'commander';
import { rotateInboxKeys } from '../../services/inbox-management';
import { resolveRotationDeviceSelection } from '../../services/key-rotation-device-selection';
import { maybeOfferBackupAfterKeyCreation } from '../../services/key-backup-prompt';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { cyan, red, renderKeyValue } from '../../services/render';

type RotateKeysOptions = GlobalOptions & {
  slug?: string;
  shareDevice?: string[];
  revokeDevice?: string[];
};

export function registerAuthRotateCommand(command: Command): void {
  command
    .command('rotate')
    .description('Rotate inbox encryption and signing keys, optionally sharing or revoking devices')
    .option('--slug <slug>', 'Owned inbox slug whose keys should rotate')
    .option(
      '--share-device <id>',
      'Approved device id that should receive the rotated key snapshot',
      (value, existing: string[] = []) => [...existing, value],
      []
    )
    .option(
      '--revoke-device <id>',
      'Device id that should be revoked during key rotation',
      (value, existing: string[] = []) => [...existing, value],
      []
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as RotateKeysOptions;
      await runCommandAction({
        title: 'Masumi auth rotate',
        options,
        preferPlainReporter: true,
        run: async ({ reporter }) => {
          const deviceSelection = await resolveRotationDeviceSelection({
            profileName: options.profile,
            json: options.json,
            reporter,
            explicitShareDeviceIds: options.shareDevice ?? [],
            explicitRevokeDeviceIds: options.revokeDevice ?? [],
          });
          return rotateInboxKeys({
            profileName: options.profile,
            actorSlug: options.slug,
            shareDeviceIds: deviceSelection.shareDeviceIds,
            revokeDeviceIds: deviceSelection.revokeDeviceIds,
            reporter,
          }).then(async result => {
            if (!options.json) {
              await maybeOfferBackupAfterKeyCreation({
                profileName: options.profile,
                reporter,
                promptLabel: `Inbox keys for ${result.actor.slug} were rotated.`,
              });
            }
            return result;
          });
        },
        toHuman: result => ({
          summary: `Rotated keys for ${cyan(result.actor.slug)}.`,
          details: renderKeyValue([
            ...(result.sharedDeviceIds.length > 0
              ? [{ key: 'Shared to', value: result.sharedDeviceIds.join(', ') }]
              : []),
            ...(result.revokedDeviceIds.length > 0
              ? [{ key: 'Revoked', value: result.revokedDeviceIds.join(', '), color: red }]
              : []),
          ]),
        }),
      });
    });
}
