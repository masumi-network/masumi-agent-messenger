import type { Command } from 'commander';
import { claimDeviceShare } from '../../services/device';
import { userError } from '../../services/errors';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { green, renderKeyValue, yellow } from '../../services/render';

type ClaimOptions = GlobalOptions & {
  timeout?: string;
};

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw userError('Timeout must be a non-negative integer number of seconds.', {
      code: 'INVALID_DEVICE_CLAIM_TIMEOUT',
    });
  }
  return seconds * 1_000;
}

export function registerDeviceClaimCommand(command: Command): void {
  command
    .command('claim')
    .description('Import an approved one-time key share bundle on this device')
    .option(
      '--timeout <seconds>',
      'Seconds to wait for an approved bundle before giving up. Use 0 to return immediately.'
    )
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ClaimOptions;
      await runCommandAction({
        title: 'Masumi auth device claim',
        options,
        run: ({ reporter }) =>
          claimDeviceShare({
            profileName: options.profile,
            reporter,
            timeoutMs: parseTimeoutMs(options.timeout),
          }),
        toHuman: result => ({
          summary: result.imported
            ? green('Imported shared private keys.')
            : yellow(
                'No approved device share bundle was available before the claim window closed.'
              ),
          details: result.imported
            ? renderKeyValue([
                { key: 'Shared actors', value: String(result.sharedActorCount) },
                { key: 'Shared key versions', value: String(result.sharedKeyVersionCount) },
                ...(result.pendingImportedRotationKeyCount > 0
                  ? [
                      {
                        key: 'Pending confirmations',
                        value: String(result.pendingImportedRotationKeyCount),
                      },
                    ]
                  : []),
                { key: 'Trust fingerprint', value: result.trustPhrase },
              ])
            : renderKeyValue([
                { key: 'Device', value: result.deviceId },
                { key: 'Trust fingerprint', value: result.trustPhrase },
              ]),
        }),
      });
    });
}
