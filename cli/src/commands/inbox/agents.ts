import process from 'node:process';
import type { Command } from 'commander';
import type { GlobalOptions } from '../../services/command-runtime';
import { invokeMenuCommand } from '../menu';

type AgentsOptions = GlobalOptions;

export function registerInboxAgentListCommand(command: Command): void {
  command
    .command('list', { hidden: true })
    .description('Deprecated alias for `masumi-agent-messenger inbox list`')
    .action(async (_options: unknown, commandInstance: Command) => {
      const options = commandInstance.optsWithGlobals() as AgentsOptions;
      if (!options.json) {
        process.stdout.write('[warn] `masumi-agent-messenger inbox agent list` is deprecated. Use `masumi-agent-messenger inbox list`.\n');
      }
      await invokeMenuCommand(options, ['inbox', 'list']);
    });
}
