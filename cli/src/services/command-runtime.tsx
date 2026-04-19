import process from 'node:process';
import type { ReactNode } from 'react';
import { render } from 'ink';
import { createInterface } from 'node:readline/promises';
import type { BirthdayCelebration } from './easter-eggs';
import { CliError, toCliError } from './errors';
import { blue, dim, green, red, yellow } from './render';
import { TaskScreen, type TaskBanner, type TaskRenderState } from '../ui/task-screen';

export type GlobalOptions = {
  json: boolean;
  profile: string;
  color: boolean;
  verbose: boolean;
};

export type TaskReporter = {
  info(text: string): void;
  success(text: string): void;
  verbose?(text: string): void;
  setBanner?(banner: TaskBanner): void;
  clearBanner?(): void;
  waitForKeypress?(message: string): Promise<void>;
};

type HumanSummary = {
  summary: string;
  details: string[];
  celebration?: BirthdayCelebration;
};
type JsonEnvelope<T> =
  | {
      schemaVersion: 1;
      ok: true;
      data: T;
    }
  | {
      schemaVersion: 1;
      ok: false;
      error: {
        message: string;
        code: string;
        try: string;
        exitCode: number;
      };
    };

const JSON_SCHEMA_VERSION = 1 as const;
const DEFAULT_TRY_HINT = 'masumi-agent-messenger --help';

type CommandActionContext = {
  reporter: TaskReporter;
};

type CommandActionParams<T> = {
  title: string;
  options: GlobalOptions;
  run: (context: CommandActionContext) => Promise<T>;
  toHuman: (result: T) => HumanSummary;
  preferPlainReporter?: boolean;
  presentInteractive?: (params: {
    result: T;
    summary: HumanSummary;
    title: string;
  }) => Promise<void>;
};

class ConsoleReporter implements TaskReporter {
  constructor(private readonly isVerbose = false) {}

  info(text: string): void {
    process.stdout.write(`${blue('[..]')} ${text}\n`);
  }

  success(text: string): void {
    process.stdout.write(`${green('[ok]')} ${text}\n`);
  }

  verbose(text: string): void {
    if (!this.isVerbose) {
      return;
    }
    process.stdout.write(`${dim('[..]')} ${text}\n`);
  }

  setBanner(banner: TaskBanner): void {
    process.stdout.write(`\n${yellow('Your code:')} ${banner.userCode}\n${dim(banner.hint)}\n\n`);
  }

  clearBanner(): void {}

  async waitForKeypress(message: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      await readline.question(`${message}\n`);
    } finally {
      readline.close();
    }
  }
}

class InkReporter implements TaskReporter {
  private state: TaskRenderState;
  private readonly rerender: (tree: ReactNode) => void;
  private readonly isVerbose: boolean;

  constructor(title: string, rerender: (tree: ReactNode) => void, verbose?: boolean) {
    this.state = {
      title,
      events: [],
    };
    this.rerender = rerender;
    this.isVerbose = Boolean(verbose);
    this.flush();
  }

  info(text: string): void {
    this.state.events.push({ kind: 'info', text });
    this.state.active = text;
    this.flush();
  }

  success(text: string): void {
    this.state.events.push({ kind: 'success', text });
    this.state.active = undefined;
    this.flush();
  }

  verbose(text: string): void {
    if (!this.isVerbose) return;
    this.state.events.push({ kind: 'info', text });
    this.state.active = text;
    this.flush();
  }

  setBanner(banner: TaskBanner): void {
    this.state.banner = banner;
    this.flush();
  }

  clearBanner(): void {
    this.state.banner = undefined;
    this.flush();
  }

  waitForKeypress(message: string): Promise<void> {
    return new Promise<void>(resolve => {
      this.state.prompt = {
        message,
        onConfirm: () => {
          this.state.prompt = undefined;
          this.flush();
          resolve();
        },
      };
      this.state.active = undefined;
      this.flush();
    });
  }

  fail(error: string): void {
    this.state.events.push({ kind: 'error', text: error });
    this.state.active = undefined;
    this.flush();
  }

  finish(summary: HumanSummary): void {
    this.state = {
      ...this.state,
      final: {
        kind: 'success',
        summary: summary.summary,
        details: summary.details,
        celebration: summary.celebration,
      },
      active: undefined,
      banner: undefined,
      prompt: undefined,
    };
    this.flush();
  }

  finishError(error: string): void {
    this.state = {
      ...this.state,
      final: {
        kind: 'error',
        summary: error,
        details: [],
      },
      active: undefined,
      banner: undefined,
      prompt: undefined,
    };
    this.flush();
  }

  private flush(): void {
    this.rerender(<TaskScreen state={this.state} />);
  }
}

function createNoopReporter(): TaskReporter {
  return {
    info() {},
    success() {},
  };
}

function isInteractive(options: GlobalOptions): boolean {
  return !options.json && Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function isPlainHumanMode(options: GlobalOptions): boolean {
  return !options.json && !isInteractive(options);
}

function applyColorPreference(options: GlobalOptions): void {
  if (options.color) {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    return;
  }

  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '0';
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Render a CliError to stdout/stderr using the same envelope and human
 * formatting as `runCommandAction`. Intended for errors that are thrown
 * outside the `run()` body (e.g. precondition guards in an action handler,
 * or uncaught exceptions from `parseAsync`).
 */
export function emitCliError(
  error: unknown,
  options: { json?: boolean; color?: boolean } = {}
): void {
  if (options.color !== undefined) {
    applyColorPreference({
      json: Boolean(options.json),
      profile: 'default',
      color: options.color,
      verbose: false,
    });
  }

  const cliError = toCliError(error);
  if (options.json) {
    writeJson(toErrorPayload(cliError));
  } else {
    process.stdout.write(`${red('[fail]')} ${cliError.message}\n`);
    process.stdout.write(`  ${dim('code:')} ${cliError.code}\n`);
    process.stdout.write(`  ${dim('Try:')} ${resolveTryHint(cliError)}\n`);
  }
  process.exitCode = cliError.exitCode;
}

async function withSuppressedConsoleOutput<T>(run: () => Promise<T>): Promise<T> {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    return await run();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function printPlainSummary(summary: HumanSummary, isVerbose: boolean): void {
  process.stdout.write(`${green('[done]')} ${summary.summary}\n`);
  const detailsToPrint =
    isVerbose || summary.details.length <= 1 ? summary.details : summary.details.slice(0, 1);
  for (const detail of detailsToPrint) {
    process.stdout.write(`${detail}\n`);
  }
  if (!isVerbose && summary.details.length > detailsToPrint.length) {
    const remaining = summary.details.length - detailsToPrint.length;
    process.stdout.write(`${dim(`  ... ${remaining} more detail line(s). Re-run with --verbose.`)}\n`);
  }
  if (summary.celebration) {
    process.stdout.write(`${yellow(summary.celebration.message)}\n`);
    for (const line of summary.celebration.fireworks) {
      process.stdout.write(`${line}\n`);
    }
  }
}

function resolveTryHint(error: CliError): string {
  return error.hint?.trim() || DEFAULT_TRY_HINT;
}

function toErrorPayload(error: CliError): JsonEnvelope<never> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: false,
    error: {
      message: error.message,
      code: error.code,
      try: resolveTryHint(error),
      exitCode: error.exitCode,
    },
  };
}

export async function runCommandAction<T>(params: CommandActionParams<T>): Promise<void> {
  applyColorPreference(params.options);

  if (params.options.json) {
    try {
      const result = await withSuppressedConsoleOutput(() =>
        params.run({ reporter: createNoopReporter() })
      );
      const payload: JsonEnvelope<T> = {
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: true,
        data: result,
      };
      writeJson(payload);
    } catch (error) {
      const cliError = toCliError(error);
      writeJson(toErrorPayload(cliError));
      process.exitCode = cliError.exitCode;
    }
    return;
  }

  if (params.preferPlainReporter || isPlainHumanMode(params.options)) {
    const reporter = params.preferPlainReporter
      ? new ConsoleReporter(params.options.verbose)
      : params.options.verbose
        ? new ConsoleReporter(true)
        : createNoopReporter();
    try {
      const result = await params.run({ reporter });
      printPlainSummary(params.toHuman(result), params.options.verbose);
    } catch (error) {
      const cliError = toCliError(error);
      process.stdout.write(`${red('[fail]')} ${cliError.message}\n`);
      process.stdout.write(`  ${dim('code:')} ${cliError.code}\n`);
      process.stdout.write(`  ${dim('Try:')} ${resolveTryHint(cliError)}\n`);
      process.exitCode = cliError.exitCode;
    }
    return;
  }

  const instance = render(<TaskScreen state={{ title: params.title, events: [] }} />, {
    patchConsole: false,
    exitOnCtrlC: true,
  });
  const reporter = new InkReporter(params.title, instance.rerender, params.options.verbose);
  let shouldManualUnmount = true;

  try {
    const result = await params.run({ reporter });
    const summary = params.toHuman(result);
    if (params.presentInteractive) {
      shouldManualUnmount = false;
      instance.unmount();
      await params.presentInteractive({
        result,
        summary,
        title: params.title,
      });
      return;
    }
    reporter.finish(summary);
    if (summary.celebration) {
      shouldManualUnmount = false;
      await instance.waitUntilExit();
    }
  } catch (error) {
    const cliError = toCliError(error);
    const errorMessage = `${cliError.message}\n  code: ${cliError.code}\n  Try: ${resolveTryHint(cliError)}`;
    reporter.fail(errorMessage);
    reporter.finishError(errorMessage);
    process.exitCode = cliError.exitCode;
  } finally {
    if (shouldManualUnmount) {
      instance.unmount();
    }
  }
}
