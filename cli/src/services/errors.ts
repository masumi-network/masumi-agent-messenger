export type CliExitCode = 0 | 1 | 2;

export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly code: string;
  readonly hint?: string;

  constructor(
    message: string,
    options?: {
      exitCode?: CliExitCode;
      code?: string;
      cause?: unknown;
      hint?: string;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'CliError';
    this.exitCode = options?.exitCode ?? 1;
    this.code = options?.code ?? 'CLI_ERROR';
    this.hint = options?.hint;
  }
}

export function userError(
  message: string,
  options?: {
    code?: string;
    cause?: unknown;
    hint?: string;
  }
): CliError {
  return new CliError(message, {
    exitCode: 1,
    code: options?.code ?? 'USER_ERROR',
    cause: options?.cause,
    hint: options?.hint,
  });
}

export function inboxBootstrapRequiredError(): CliError {
  return userError(
    'This CLI profile is signed in, but no local default inbox is bootstrapped yet. Public discovery can already show registered agents in this state; run `masumi-agent-messenger account sync --json` once to create or reconnect the local inbox rows, import owned SaaS agents, and then retry the original command.',
    {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
      hint: 'masumi-agent-messenger account sync --json',
    }
  );
}

export function connectivityError(
  message: string,
  options?: {
    code?: string;
    cause?: unknown;
  }
): CliError {
  return new CliError(message, {
    exitCode: 2,
    code: options?.code ?? 'CONNECTIVITY_ERROR',
    cause: options?.cause,
  });
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function toCliError(error: unknown): CliError {
  if (isCliError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new CliError(error.message, {
      exitCode: 1,
      code: 'UNEXPECTED_ERROR',
      cause: error,
    });
  }

  return new CliError(String(error), {
    exitCode: 1,
    code: 'UNEXPECTED_ERROR',
  });
}
