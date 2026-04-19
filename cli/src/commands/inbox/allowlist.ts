import type { Command } from 'commander';
import {
  addContactAllowlist,
  listContactAllowlist,
  removeContactAllowlist,
} from '../../services/contact-management';
import { runCommandAction, type GlobalOptions } from '../../services/command-runtime';
import {
  bold,
  cyan,
  renderEmptyWithTry,
  renderTable,
  senderColor,
} from '../../services/render';

type AllowlistListOptions = GlobalOptions;

type AllowlistMutateOptions = GlobalOptions & {
  agent?: string;
  email?: string;
};

export function registerInboxAllowlistCommand(command: Command): void {
  const allowlist = command
    .command('allowlist')
    .description('Manage inbox-wide first-contact allowlist entries');

  allowlist
    .command('list')
    .description('List current inbox-wide allowlist entries')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AllowlistListOptions;
      await runCommandAction({
        title: 'masumi-agent-messenger inbox allowlist list',
        options,
        run: ({ reporter }) =>
          listContactAllowlist({
            profileName: options.profile,
            reporter,
          }),
        toHuman: result => {
          if (result.entries.length === 0) {
            return {
              summary: renderEmptyWithTry(
                'No allowlist entries.',
                'masumi-agent-messenger inbox allowlist add --agent <slug>'
              ),
              details: [],
            };
          }

          return {
            summary: `${bold(String(result.total))} allowlist entr${result.total === 1 ? 'y' : 'ies'}.`,
            details: renderTable(
              result.entries.map(entry => ({
                id: `#${entry.id}`,
                kind: entry.kind,
                value: entry.value,
                label: entry.label ?? '',
                created: entry.createdAt,
              })),
              [
                { header: 'Entry', key: 'id', color: cyan },
                { header: 'Kind', key: 'kind' },
                { header: 'Value', key: 'value', color: senderColor },
                { header: 'Label', key: 'label' },
                { header: 'Created', key: 'created' },
              ]
            ),
          };
        },
      });
    });

  allowlist
    .command('add')
    .description('Add an inbox-wide allowlist entry')
    .option('--agent <slug>', 'Allowlist an inbox slug/public identity')
    .option('--email <email>', 'Allowlist an exact verified sender email')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AllowlistMutateOptions;
      await runCommandAction({
        title: 'masumi-agent-messenger inbox allowlist add',
        options,
        run: ({ reporter }) =>
          addContactAllowlist({
            profileName: options.profile,
            reporter,
            agent: options.agent,
            email: options.email,
          }),
        toHuman: result => ({
          summary: `Added ${result.kind} allowlist entry ${senderColor(result.value)}.`,
          details: [],
        }),
      });
    });

  allowlist
    .command('remove')
    .description('Remove an inbox-wide allowlist entry')
    .option('--agent <slug>', 'Remove an inbox slug/public identity entry')
    .option('--email <email>', 'Remove an exact email entry')
    .action(async (_options, commandInstance) => {
      const options = commandInstance.optsWithGlobals() as AllowlistMutateOptions;
      await runCommandAction({
        title: 'masumi-agent-messenger inbox allowlist remove',
        options,
        run: ({ reporter }) =>
          removeContactAllowlist({
            profileName: options.profile,
            reporter,
            agent: options.agent,
            email: options.email,
          }),
        toHuman: result => ({
          summary: `Removed ${result.kind} allowlist entry ${senderColor(result.value)}.`,
          details: [],
        }),
      });
    });
}
