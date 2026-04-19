import type { Command } from 'commander';
import { registerDeviceApproveCommand } from '../device/approve';
import { registerDeviceClaimCommand } from '../device/claim';
import { registerDeviceListCommand } from '../device/list';
import { registerDeviceRequestShareCommand } from '../device/request-share';
import { registerDeviceRevokeCommand } from '../device/revoke';
import type { GlobalOptions } from '../../services/command-runtime';
import { chooseMenuAction, invokeMenuCommand, isInteractiveHumanMode, promptForMenuText, showCommandHelp } from '../menu';

export function registerAuthDeviceCommands(command: Command): void {
  const device = command.command('device').description('Device enrollment and key sharing commands');

  device.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    if (!isInteractiveHumanMode(options)) {
      showCommandHelp(commandInstance);
      return;
    }

    const choice = await chooseMenuAction({
      question: 'Which device action do you want?',
      defaultValue: 'request',
      options: [
        { value: 'request', label: 'Request keys from another device' },
        { value: 'claim', label: 'Import approved shared keys on this device' },
        { value: 'approve', label: 'Approve a pending device share' },
        { value: 'list', label: 'List devices' },
        { value: 'revoke', label: 'Revoke a device' },
      ],
    });

    if (choice === 'revoke') {
      const deviceId = await promptForMenuText({
        question: 'Device id to revoke',
      });
      await invokeMenuCommand(options, ['auth', 'device', 'revoke', '--device-id', deviceId]);
      return;
    }

    if (choice === 'request') {
      // Chain request + claim so humans see the same end-to-end experience
      // as the pre-split flow. Scripts should invoke each command directly
      // with their own orchestration.
      await invokeMenuCommand(options, ['auth', 'device', 'request']);
      await invokeMenuCommand(options, ['auth', 'device', 'claim']);
      return;
    }

    await invokeMenuCommand(options, ['auth', 'device', choice]);
  });

  registerDeviceRequestShareCommand(device);
  registerDeviceClaimCommand(device);
  registerDeviceApproveCommand(device);
  registerDeviceListCommand(device);
  registerDeviceRevokeCommand(device);
}
