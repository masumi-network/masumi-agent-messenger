import type { Command } from 'commander';
import { listDevices } from '../../services/device';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  badge,
  bold,
  dim,
  green,
  renderEmptyWithTry,
  renderTable,
  yellow,
  type TableColumn,
} from '../../services/render';

type ListOptions = GlobalOptions;

export function registerDeviceListCommand(command: Command): void {
  command
    .command('list')
    .description('List enrolled devices for the current inbox owner')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as ListOptions;
      await runCommandAction({
        title: 'Masumi auth device list',
        options,
        run: ({ reporter }) =>
          listDevices({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => {
          const COLUMNS: TableColumn[] = [
            { header: 'Device', key: 'name', color: bold },
            { header: 'Platform', key: 'platform', color: dim },
            { header: 'Status', key: 'status' },
            { header: 'Pending', key: 'pending' },
          ];
          return {
            summary:
              result.devices.length === 0
                ? renderEmptyWithTry(
                    'No devices registered.',
                    'masumi-agent-messenger auth device request'
                  )
                : `${bold(String(result.devices.length))} device${result.devices.length === 1 ? '' : 's'} enrolled.`,
            details:
              result.devices.length === 0
                ? []
                : renderTable(
                    result.devices.map(device => ({
                      name: device.label ?? device.deviceId,
                      platform: device.platform ?? '',
                      status: device.status === 'active' ? badge('active', green) : badge(device.status, yellow),
                      pending: device.pendingRequestCount > 0 ? badge(`${device.pendingRequestCount} pending`, yellow) : '',
                    })),
                    COLUMNS
                  ),
          };
        },
      });
    });
}
