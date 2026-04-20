import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

type PromptOutputLifecycle = {
  beforePrompt(): void;
  afterPrompt(): void;
};

let promptOutputLifecycle: PromptOutputLifecycle | undefined;

export function installPromptOutputLifecycle(hooks: PromptOutputLifecycle): () => void {
  const previous = promptOutputLifecycle;
  promptOutputLifecycle = hooks;
  return () => {
    promptOutputLifecycle = previous;
  };
}

export async function withPromptOutputSuspended<T>(run: () => Promise<T>): Promise<T> {
  const lifecycle = promptOutputLifecycle;
  lifecycle?.beforePrompt();
  try {
    return await run();
  } finally {
    lifecycle?.afterPrompt();
  }
}

function interactiveStdioAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function confirmYesNo(params: {
  question: string;
  defaultValue?: boolean;
}): Promise<boolean> {
  if (!interactiveStdioAvailable()) {
    return params.defaultValue ?? false;
  }

  const { green, symbols } = await import('./render');

  const suffix =
    params.defaultValue === true ? ' [Y/n] ' : params.defaultValue === false ? ' [y/N] ' : ' [y/n] ';
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return withPromptOutputSuspended(async () => {
    try {
      const answer = (await readline.question(`${green(symbols.bullet)} ${params.question}${suffix}`)).trim().toLowerCase();
      if (!answer) {
        return params.defaultValue ?? false;
      }
      return answer === 'y' || answer === 'yes';
    } finally {
      readline.close();
    }
  });
}

export async function waitForEnterMessage(message: string): Promise<void> {
  if (!interactiveStdioAvailable()) {
    return;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return withPromptOutputSuspended(async () => {
    try {
      await readline.question(`${message}\n`);
    } finally {
      readline.close();
    }
  });
}

export async function promptText(params: {
  question: string;
  defaultValue?: string;
}): Promise<string> {
  if (!interactiveStdioAvailable()) {
    return params.defaultValue ?? '';
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return withPromptOutputSuspended(async () => {
    try {
      const suffix =
        params.defaultValue && params.defaultValue.length > 0
          ? ` [default: ${params.defaultValue}] `
          : ' ';
      const answer = await readline.question(`${params.question}${suffix}`);
      const trimmed = answer.trim();
      if (!trimmed) {
        return params.defaultValue ?? '';
      }
      return trimmed;
    } finally {
      readline.close();
    }
  });
}

export async function promptSecret(params: {
  question: string;
  defaultValue?: string;
}): Promise<string> {
  if (!interactiveStdioAvailable()) {
    return params.defaultValue ?? '';
  }

  const suffix =
    params.defaultValue && params.defaultValue.length > 0
      ? ' [press Enter to keep the current value] '
      : ' ';

  return withPromptOutputSuspended(async () => new Promise<string>((resolve, reject) => {
    process.stdout.write(`${params.question}${suffix}`);

    const input = process.stdin;
    const wasRaw = input.isTTY ? input.isRaw : false;
    let answer = '';
    let cursor = 0;
    let finished = false;

    const cleanup = () => {
      if (finished) {
        return;
      }
      finished = true;
      input.off('keypress', onKeypress);
      if (input.isTTY) {
        input.setRawMode(Boolean(wasRaw));
      }
      input.pause();
      process.stdout.write('\n');
    };

    const onKeypress = (chunk: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Prompt cancelled.'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        const value = answer || params.defaultValue || '';
        cleanup();
        resolve(value);
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        if (key.name === 'backspace') {
          if (cursor <= 0) {
            return;
          }
          answer = answer.slice(0, cursor - 1) + answer.slice(cursor);
          cursor -= 1;
          return;
        }
        if (cursor >= answer.length) {
          return;
        }
        answer = answer.slice(0, cursor) + answer.slice(cursor + 1);
        return;
      }

      if (key.name === 'left') {
        cursor = Math.max(0, cursor - 1);
        return;
      }

      if (key.name === 'right') {
        cursor = Math.min(answer.length, cursor + 1);
        return;
      }

      if (key.ctrl || key.meta) {
        return;
      }

      if (typeof chunk === 'string' && chunk.length > 0) {
        answer = answer.slice(0, cursor) + chunk + answer.slice(cursor);
        cursor += chunk.length;
      }
    };

    emitKeypressEvents(input);
    if (input.isTTY) {
      input.setRawMode(true);
    }
    input.resume();
    input.on('keypress', onKeypress);
  }));
}

export async function promptChoice<T extends string>(params: {
  question: string;
  options: Array<{
    value: T;
    label: string;
  }>;
  defaultValue?: T;
}): Promise<T> {
  if (!interactiveStdioAvailable()) {
    if (params.defaultValue !== undefined) {
      return params.defaultValue;
    }
    return params.options[0]!.value;
  }

  const { cyan, dim, symbols } = await import('./render');

  const defaultIndex = params.defaultValue
    ? params.options.findIndex(o => o.value === params.defaultValue)
    : 0;
  let selected = Math.max(0, defaultIndex);

  const renderOptions = () => {
    const lines = [`  ${params.question}`];
    for (let i = 0; i < params.options.length; i++) {
      const label = params.options[i]!.label;
      if (i === selected) {
        lines.push(`    ${cyan(`${symbols.pointer} ${label}`)}`);
      } else {
        lines.push(`      ${dim(label)}`);
      }
    }
    lines.push(dim(`  ↑/↓ select ${symbols.dot} Enter confirm`));
    return lines;
  };

  return withPromptOutputSuspended(async () => new Promise<T>((resolve, reject) => {
    let renderedLines = renderOptions();
    process.stdout.write(renderedLines.join('\n') + '\n');

    const input = process.stdin;
    const wasRaw = input.isTTY ? input.isRaw : false;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.off('keypress', onKeypress);
      if (input.isTTY) {
        input.setRawMode(Boolean(wasRaw));
      }
      input.pause();
    };

    const redraw = () => {
      const count = renderedLines.length;
      process.stdout.write(`\x1b[${count}A\x1b[J`);
      renderedLines = renderOptions();
      process.stdout.write(renderedLines.join('\n') + '\n');
    };

    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Prompt cancelled.'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(params.options[selected]!.value);
        return;
      }

      if (key.name === 'up') {
        selected = selected <= 0 ? params.options.length - 1 : selected - 1;
        redraw();
        return;
      }

      if (key.name === 'down') {
        selected = selected >= params.options.length - 1 ? 0 : selected + 1;
        redraw();
        return;
      }
    };

    emitKeypressEvents(input);
    if (input.isTTY) {
      input.setRawMode(true);
    }
    input.resume();
    input.on('keypress', onKeypress);
  }));
}

export async function promptMultiline(params: {
  question: string;
  doneMessage?: string;
}): Promise<string> {
  if (!interactiveStdioAvailable()) {
    return '';
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return withPromptOutputSuspended(async () => {
    try {
      const lines: string[] = [];
      process.stdout.write(
        `${params.question}\n${params.doneMessage ?? 'Press Enter on an empty line to finish.'}\n`
      );
      while (true) {
        const line = await readline.question(lines.length === 0 ? '> ' : '. ');
        if (line.length === 0) {
          break;
        }
        lines.push(line);
      }
      return lines.join('\n').trim();
    } finally {
      readline.close();
    }
  });
}
