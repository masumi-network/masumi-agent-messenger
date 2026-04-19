import type { Command } from 'commander';
import { logout } from '../../services/auth';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import { dim, renderKeyValue } from '../../services/render';
import { confirmYesNo } from '../../services/prompts';
import { userError } from '../../services/errors';

type LogoutOptions = GlobalOptions & {
  yes?: boolean;
};

export function registerAuthLogoutCommand(command: Command): void {
  command
    .command('logout')
    .description('Clear local auth session (keeps local keys)')
    .option('--yes', 'Skip confirmation and clear local auth state (dangerous)')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as LogoutOptions;
      await runCommandAction({
        title: 'Masumi auth logout',
        options,
        run: ({ reporter }) =>
          (async () => {
            if (!options.yes) {
              const confirmed = await confirmYesNo({
                defaultValue: false,
                question:
                  'This will remove the local OIDC session for this profile.\n' +
                  'Local agent keys and device key material will be kept.\n' +
                  'Use `masumi-agent-messenger auth keys-remove` to wipe local keys from this device.\n\n' +
                  'Continue?',
              });

              if (!confirmed) {
                throw userError('Logout cancelled.', { code: 'AUTH_LOGOUT_CANCELLED' });
              }
            }

            return logout({
              profileName: options.profile,
              reporter,
            });
          })(),
        toHuman: result => ({
          summary: 'Signed out.',
          details: renderKeyValue([
            { key: 'Profile', value: result.profile, color: dim },
            { key: 'Local keys', value: 'kept', color: dim },
          ]),
        }),
      });
    });
}
