import type { Command } from 'commander';
import { registerDeviceApproveCommand } from './approve';
import { registerDeviceClaimCommand } from './claim';
import { registerDeviceListCommand } from './list';
import { registerDeviceRequestShareCommand } from './request-share';
import { registerDeviceRevokeCommand } from './revoke';

export function registerDeviceCommands(program: Command): void {
  const device = program.command('device').description('Device enrollment and key sharing commands');
  registerDeviceRequestShareCommand(device);
  registerDeviceClaimCommand(device);
  registerDeviceApproveCommand(device);
  registerDeviceListCommand(device);
  registerDeviceRevokeCommand(device);
}

