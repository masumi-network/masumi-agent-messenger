import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { installPromptOutputLifecycle, withPromptOutputSuspended } from './prompts';

const SHOW_CURSOR = '\u001B[?25h';

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

describe('prompt output lifecycle', () => {
  it('fires lifecycle hooks around prompt output work', async () => {
    const calls: string[] = [];
    const restore = installPromptOutputLifecycle({
      beforePrompt: () => {
        calls.push('before');
      },
      afterPrompt: () => {
        calls.push('after');
      },
    });

    try {
      const result = await withPromptOutputSuspended(async () => {
        calls.push('run');
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(calls).toEqual(['before', 'run', 'after']);
    } finally {
      restore();
    }
  });

  it('shows the terminal cursor while prompt output is suspended', async () => {
    const writes: string[] = [];
    const restoreStdinTTY = stubIsTTY(process.stdin, true);
    const restoreStdoutTTY = stubIsTTY(process.stdout, true);
    const originalWrite = process.stdout.write;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await withPromptOutputSuspended(async () => {
        expect(writes).toEqual([SHOW_CURSOR]);
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(writes).toEqual([SHOW_CURSOR, SHOW_CURSOR]);
    } finally {
      process.stdout.write = originalWrite;
      restoreStdoutTTY();
      restoreStdinTTY();
    }
  });

  it('fires afterPrompt when prompt output work fails', async () => {
    const calls: string[] = [];
    const restore = installPromptOutputLifecycle({
      beforePrompt: () => {
        calls.push('before');
      },
      afterPrompt: () => {
        calls.push('after');
      },
    });

    try {
      await expect(
        withPromptOutputSuspended(async () => {
          calls.push('run');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(calls).toEqual(['before', 'run', 'after']);
    } finally {
      restore();
    }
  });

  it('restores the previous lifecycle when uninstalled', async () => {
    const calls: string[] = [];
    const restoreOuter = installPromptOutputLifecycle({
      beforePrompt: () => {
        calls.push('outer-before');
      },
      afterPrompt: () => {
        calls.push('outer-after');
      },
    });
    const restoreInner = installPromptOutputLifecycle({
      beforePrompt: () => {
        calls.push('inner-before');
      },
      afterPrompt: () => {
        calls.push('inner-after');
      },
    });

    try {
      await withPromptOutputSuspended(async () => {
        calls.push('inner-run');
      });

      restoreInner();

      await withPromptOutputSuspended(async () => {
        calls.push('outer-run');
      });

      expect(calls).toEqual([
        'inner-before',
        'inner-run',
        'inner-after',
        'outer-before',
        'outer-run',
        'outer-after',
      ]);
    } finally {
      restoreOuter();
    }
  });
});
