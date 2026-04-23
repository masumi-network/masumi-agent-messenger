import process from 'node:process';
import type { Command } from 'commander';
import type { GlobalOptions } from '../services/command-runtime';
import { promptChoice, promptMultiline, promptText } from '../services/prompts';

export function isInteractiveHumanMode(options: GlobalOptions): boolean {
  return !options.json && Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
}

export function toGlobalArgs(options: GlobalOptions): string[] {
  const args = ['--profile', options.profile];
  if (options.json) {
    args.push('--json');
  }
  if (options.verbose) {
    args.push('--verbose');
  }
  if (!options.color) {
    args.push('--no-color');
  }
  return args;
}

export async function invokeMenuCommand(options: GlobalOptions, args: string[]): Promise<void> {
  const { buildProgram } = await import('../program');
  await buildProgram().parseAsync(['node', 'masumi-agent-messenger', ...toGlobalArgs(options), ...args]);
}

export async function chooseMenuAction<T extends string>(params: {
  question: string;
  options: Array<{ value: T; label: string }>;
  defaultValue?: T;
}): Promise<T> {
  return promptChoice(params);
}

export function showCommandHelp(command: Command): void {
  command.outputHelp();
}

export async function promptForMenuText(params: {
  question: string;
  defaultValue?: string;
  placeholder?: string;
}): Promise<string> {
  return promptText(params);
}

export async function promptForMenuMessage(question: string): Promise<string> {
  return promptMultiline({
    question,
    doneMessage: 'Press Enter on an empty line to send.',
  });
}
