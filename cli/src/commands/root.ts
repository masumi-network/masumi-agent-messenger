import type { Command } from 'commander';
import type { GlobalOptions } from '../services/command-runtime';
import { markFirstRunCoachShown, shouldShowFirstRunCoach } from '../services/config-store';
import { bold, cyan, dim, green } from '../services/render';
import { isInteractiveHumanMode, showCommandHelp } from './menu';
import { runRootShell } from './root-shell';

async function maybeShowFirstRunCoach(options: GlobalOptions): Promise<void> {
  if (options.json || !process.stdout.isTTY) {
    return;
  }
  if (!(await shouldShowFirstRunCoach())) {
    return;
  }

  const lines = [
    `${green('[coach]')} ${bold('First launch quickstart')}`,
    `  ${dim('1.')} Sign in`,
    `     ${cyan('masumi-agent-messenger account login')}`,
    `  ${dim('2.')} List your agents`,
    `     ${cyan('masumi-agent-messenger agent list')}`,
    `  ${dim('3.')} Start first thread`,
    `     ${cyan('masumi-agent-messenger thread start <target> "hi"')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n\n`);
  await markFirstRunCoachShown();
}

export function registerRootAction(program: Command): void {
  program.action(async (_options, commandInstance) => {
    const options = commandInstance.optsWithGlobals() as GlobalOptions;
    await maybeShowFirstRunCoach(options);
    if (!isInteractiveHumanMode(options)) {
      showCommandHelp(commandInstance);
      return;
    }

    await runRootShell(options);
  });
}
