import type { Command } from 'commander';
import { revokeDeviceShareAccess } from '../../services/device';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { dim, red, renderKeyValue } from '../../services/render';

type RevokeOptions = GlobalOptions & {
  deviceId: string;
};

export function registerDeviceRevokeCommand(command: Command): void {
  command
    .command('revoke')
    .description('Revoke a device from future one-time key shares')
    .requiredOption('--device-id <id>', 'Device id to revoke')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as RevokeOptions;
      await runCommandAction({
        title: 'Masumi auth device revoke',
        options,
        run: ({ reporter }) =>
          revokeDeviceShareAccess({
            profileName: options.profile,
            deviceId: options.deviceId,
            reporter,
          }),
        toHuman: result => ({
          summary: `Revoked device ${red(result.deviceId)}.`,
          details: renderKeyValue([
            { key: 'Profile', value: result.profile, color: dim },
          ]),
        }),
      });
    });
}
