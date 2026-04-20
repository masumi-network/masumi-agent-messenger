import { describe, expect, it } from 'vitest';
import { installPromptOutputLifecycle, withPromptOutputSuspended } from './prompts';

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
