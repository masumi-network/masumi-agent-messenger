import type { Command } from 'commander';
import { registerBackupExportCommand } from '../inbox/backup-keys';
import { registerBackupImportCommand } from '../inbox/restore-keys';
import type { GlobalOptions } from '../../services/command-runtime';
import { chooseMenuAction, invokeMenuCommand, isInteractiveHumanMode, showCommandHelp } from '../menu';

export function registerAuthBackupCommands(command: Command): void {
  const backup = command.command('backup').description('Encrypted inbox key backup commands');

  backup.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    if (!isInteractiveHumanMode(options)) {
      showCommandHelp(commandInstance);
      return;
    }

    const choice = await chooseMenuAction({
      question: 'Which backup action do you want?',
      defaultValue: 'export',
      options: [
        { value: 'export', label: 'Export encrypted backup' },
        { value: 'import', label: 'Import encrypted backup' },
      ],
    });

    await invokeMenuCommand(options, ['auth', 'backup', choice]);
  });

  registerBackupExportCommand(backup);
  registerBackupImportCommand(backup);
}
