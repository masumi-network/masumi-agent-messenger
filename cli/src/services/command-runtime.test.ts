import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockPromptState = {
  prompt?: {
    kind?: string;
    onCancel?: () => void;
  };
  final?: {
    summary: string;
  };
};

type MockRenderTree = {
  props?: {
    state?: MockPromptState;
  };
};

function stubIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', {
    configurable: true,
    value,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
    } else {
      delete (stream as { isTTY?: boolean }).isTTY;
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('ink');
});

describe('runCommandAction prompt mode', () => {
  it('uses plain output instead of Ink when stdin is not interactive', async () => {
    const restoreStdinTTY = stubIsTTY(process.stdin, false);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const restoreStderrTTY = stubIsTTY(process.stderr, true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const renderSpy = vi.fn((tree: MockRenderTree) => ({
      rerender: vi.fn((_nextTree: MockRenderTree) => {}),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => {}),
      tree,
    }));
    let confirmed: boolean | undefined;

    try {
      vi.resetModules();
      vi.doMock('ink', () => ({
        render: renderSpy,
        Box: () => null,
        Static: () => null,
        Text: () => null,
        useApp: () => ({ exit: vi.fn() }),
        useInput: vi.fn(),
      }));

      const { runCommandAction: runCommandActionWithMockedInk } = await import('./command-runtime');
      const { confirmYesNo: confirmYesNoWithMockedRuntime } = await import('./prompts');

      await runCommandActionWithMockedInk({
        title: 'Noninteractive prompt fallback',
        options: {
          json: false,
          profile: 'default',
          color: false,
          verbose: false,
        },
        run: async () => {
          confirmed = await confirmYesNoWithMockedRuntime({
            question: 'Continue?',
            defaultValue: true,
          });
          return confirmed;
        },
        toHuman: result => ({
          summary: 'Completed.',
          details: [String(result)],
        }),
      });
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      restoreStderrTTY();
      restoreStdoutTTY();
      restoreStdinTTY();
      vi.resetModules();
    }

    expect(confirmed).toBe(true);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[done] Completed.'));
  });

  it('aborts press-enter prompts instead of continuing when cancelled', async () => {
    const restoreStdinTTY = stubIsTTY(process.stdin, true);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const restoreStderrTTY = stubIsTTY(process.stderr, true);
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const previousExitCode = process.exitCode;
    let latestState: MockPromptState | undefined;
    let continued = false;

    vi.resetModules();
    vi.doMock('ink', () => ({
      render: vi.fn((tree: MockRenderTree) => {
        latestState = tree.props?.state;
        return {
          rerender: (nextTree: MockRenderTree) => {
            latestState = nextTree.props?.state;
          },
          unmount: vi.fn(),
          waitUntilExit: vi.fn(async () => {}),
        };
      }),
      Box: () => null,
      Static: () => null,
      Text: () => null,
      useApp: () => ({ exit: vi.fn() }),
      useInput: vi.fn(),
    }));

    try {
      const { runCommandAction: runCommandActionWithMockedInk } = await import('./command-runtime');
      const runPromise = runCommandActionWithMockedInk({
        title: 'Press-enter cancellation',
        options: {
          json: false,
          profile: 'default',
          color: false,
          verbose: false,
        },
        run: async ({ reporter }) => {
          await reporter.waitForKeypress?.('Press Enter to continue');
          continued = true;
          return 'continued';
        },
        toHuman: result => ({
          summary: result,
          details: [],
        }),
      });

      await vi.waitFor(() => {
        expect(latestState?.prompt?.kind).toBe('press-enter');
      });

      const onCancel = latestState?.prompt?.onCancel;
      if (!onCancel) {
        throw new Error('Expected press-enter prompt to expose a cancellation handler.');
      }
      onCancel();
      await runPromise;
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      process.exitCode = previousExitCode;
      restoreStderrTTY();
      restoreStdoutTTY();
      restoreStdinTTY();
      vi.resetModules();
    }

    expect(continued).toBe(false);
    expect(latestState?.final?.summary).toContain('Prompt cancelled.');
  });

  it('preserves prompt-cancel metadata for Ink confirm prompts', async () => {
    const restoreStdinTTY = stubIsTTY(process.stdin, true);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const restoreStderrTTY = stubIsTTY(process.stderr, true);
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const previousExitCode = process.exitCode;
    let latestState: MockPromptState | undefined;
    let confirmed: boolean | undefined;

    vi.resetModules();
    vi.doMock('ink', () => ({
      render: vi.fn((tree: MockRenderTree) => {
        latestState = tree.props?.state;
        return {
          rerender: (nextTree: MockRenderTree) => {
            latestState = nextTree.props?.state;
          },
          unmount: vi.fn(),
          waitUntilExit: vi.fn(async () => {}),
        };
      }),
      Box: () => null,
      Static: () => null,
      Text: () => null,
      useApp: () => ({ exit: vi.fn() }),
      useInput: vi.fn(),
    }));

    try {
      const { runCommandAction: runCommandActionWithMockedInk } = await import('./command-runtime');
      const { confirmYesNo: confirmYesNoWithMockedRuntime } = await import('./prompts');
      const runPromise = runCommandActionWithMockedInk({
        title: 'Confirm cancellation',
        options: {
          json: false,
          profile: 'default',
          color: false,
          verbose: false,
        },
        run: async () => {
          confirmed = await confirmYesNoWithMockedRuntime({
            question: 'Continue?',
            defaultValue: true,
          });
          return confirmed;
        },
        toHuman: result => ({
          summary: String(result),
          details: [],
        }),
      });

      await vi.waitFor(() => {
        expect(latestState?.prompt?.kind).toBe('confirm');
      });

      const onCancel = latestState?.prompt?.onCancel;
      if (!onCancel) {
        throw new Error('Expected confirm prompt to expose a cancellation handler.');
      }
      onCancel();
      await runPromise;
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      process.exitCode = previousExitCode;
      restoreStderrTTY();
      restoreStdoutTTY();
      restoreStdinTTY();
      vi.resetModules();
    }

    expect(confirmed).toBeUndefined();
    expect(latestState?.final?.summary).toContain('Prompt cancelled.');
    expect(latestState?.final?.summary).toContain('code: PROMPT_CANCELLED');
    expect(latestState?.final?.summary).not.toContain('code: UNEXPECTED_ERROR');
  });
});

describe('runCommandAction --headless flag', () => {
  it('uses plain output instead of Ink when --headless is set, even in TTY', async () => {
    const restoreStdinTTY = stubIsTTY(process.stdin, true);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const restoreStderrTTY = stubIsTTY(process.stderr, true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const renderSpy = vi.fn((tree: MockRenderTree) => ({
      rerender: vi.fn((_nextTree: MockRenderTree) => {}),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => {}),
      tree,
    }));

    try {
      vi.resetModules();
      vi.doMock('ink', () => ({
        render: renderSpy,
        Box: () => null,
        Static: () => null,
        Text: () => null,
        useApp: () => ({ exit: vi.fn() }),
        useInput: vi.fn(),
      }));

      const { runCommandAction: runCommandActionWithMockedInk } = await import('./command-runtime');

      await runCommandActionWithMockedInk({
        title: 'Headless mode test',
        options: {
          json: false,
          headless: true,
          profile: 'default',
          color: false,
          verbose: false,
        },
        run: async () => 'done',
        toHuman: () => ({
          summary: 'Headless works.',
          details: [],
        }),
      });
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      restoreStderrTTY();
      restoreStdoutTTY();
      restoreStdinTTY();
      vi.resetModules();
    }

    expect(renderSpy).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('[done] Headless works.'));
  });

  it('still emits JSON when --json is used with --headless', async () => {
    const restoreStdinTTY = stubIsTTY(process.stdin, true);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const restoreStderrTTY = stubIsTTY(process.stderr, true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const renderSpy = vi.fn((tree: MockRenderTree) => ({
      rerender: vi.fn((_nextTree: MockRenderTree) => {}),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => {}),
      tree,
    }));

    try {
      vi.resetModules();
      vi.doMock('ink', () => ({
        render: renderSpy,
        Box: () => null,
        Static: () => null,
        Text: () => null,
        useApp: () => ({ exit: vi.fn() }),
        useInput: vi.fn(),
      }));

      const { runCommandAction: runCommandActionWithMockedInk } = await import('./command-runtime');

      await runCommandActionWithMockedInk({
        title: 'Headless JSON test',
        options: {
          json: true,
          headless: true,
          profile: 'default',
          color: false,
          verbose: false,
        },
        run: async () => ({ value: 42 }),
        toHuman: () => ({
          summary: 'Should not appear.',
          details: [],
        }),
      });
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      restoreStderrTTY();
      restoreStdoutTTY();
      restoreStdinTTY();
      vi.resetModules();
    }

    expect(renderSpy).not.toHaveBeenCalled();
    const lastCall = stdoutWrite.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ value: 42 });
  });
});
