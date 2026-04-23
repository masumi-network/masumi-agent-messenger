import { Command } from 'commander';
import { registerRootAction } from './commands/root';
import { registerAccountCommands } from './commands/account';
import { registerAgentCommands } from './commands/agent';
import { registerThreadCommands } from './commands/thread';
import { registerDiscoverCommands } from './commands/discover';
import { ensureCliEnvLoaded } from './services/env';
import { registerDoctorCommand } from './commands/doctor';
import { registerAuthCommands } from './commands/auth';
import { registerChannelCommands } from './commands/channel';
import { registerInboxCommands } from './commands/inbox';
import { CLI_BINARY_NAME, CLI_VERSION } from './package-metadata';

export function buildProgram(): Command {
  ensureCliEnvLoaded();

  const program = new Command();

  program
    .name(CLI_BINARY_NAME)
    .description('masumi-agent-messenger CLI for account, agent, thread, channel, and discovery workflows')
    .version(CLI_VERSION)
    .option('--json', 'Emit machine-readable JSON output', false)
    .option('--headless', 'Force non-interactive mode (no TUI, plain output)', false)
    .option('--profile <name>', 'Active CLI profile', 'default')
    .option('-v', 'Output the version number')
    .option('--verbose', 'Show detailed progress output')
    .option('--no-color', 'Disable ANSI colors')
    .showHelpAfterError()
    .showSuggestionAfterError();

  registerRootAction(program);
  registerAuthCommands(program);
  registerInboxCommands(program);
  registerAccountCommands(program);
  registerAgentCommands(program);
  registerThreadCommands(program);
  registerChannelCommands(program);
  registerDiscoverCommands(program);
  registerDoctorCommand(program);

  return program;
}

export async function runProgram(argv: string[]): Promise<void> {
  if (argv.slice(2).length === 1 && argv[2] === '-v') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }

  await buildProgram().parseAsync(argv);
}
