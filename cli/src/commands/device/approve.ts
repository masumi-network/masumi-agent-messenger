import type { Command } from 'commander';
import { approveDeviceShare } from '../../services/device';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { formatRelativeTime } from '../../services/format';
import { bold, gray, renderKeyValue } from '../../services/render';

type ApproveOptions = GlobalOptions & {
  code?: string;
  deviceId?: string;
};

export function registerDeviceApproveCommand(command: Command): void {
  command
    .command('approve')
    .description('Approve a pending one-time key share request')
    .option('--code <code>', 'Short-lived emoji verification code')
    .option('--device-id <id>', 'Target device id when approving the latest pending request')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ApproveOptions;
      await runCommandAction({
        title: 'Masumi auth device approve',
        options,
        run: ({ reporter }) =>
          approveDeviceShare({
            profileName: options.profile,
            reporter,
            code: options.code,
            deviceId: options.deviceId,
          }),
        toHuman: result => ({
          summary: `Shared keys to device ${bold(result.deviceId)}.`,
          details: renderKeyValue([
            { key: 'Shared keys', value: String(result.sharedKeyVersionCount) },
            { key: 'Bundle expires', value: formatRelativeTime(result.expiresAt), color: gray },
            { key: 'Trust fingerprint', value: result.trustPhrase },
          ]),
        }),
      });
    });
}
