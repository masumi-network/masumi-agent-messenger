import type { Command } from 'commander';
import { requestDeviceShare } from '../../services/device';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { formatRelativeTime } from '../../services/format';
import { bold, gray, renderKeyValue } from '../../services/render';

type RequestShareOptions = GlobalOptions;

export function registerDeviceRequestShareCommand(command: Command): void {
  command
    .command('request')
    .description(
      'Register a one-time encrypted key-share request and print the verification code. ' +
        'Run `masumi-agent-messenger auth device claim` on this device after another trusted device approves the request.'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as RequestShareOptions;
      await runCommandAction({
        title: 'Masumi auth device request',
        options,
        run: ({ reporter }) =>
          requestDeviceShare({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => ({
          summary: 'Device share request created. Run `masumi-agent-messenger auth device claim` after approval.',
          details: renderKeyValue([
            { key: 'Verification code', value: result.verificationCode, color: bold },
            { key: 'Expires', value: formatRelativeTime(result.expiresAt), color: gray },
            { key: 'Trust fingerprint', value: result.trustPhrase },
          ]),
        }),
      });
    });
}
