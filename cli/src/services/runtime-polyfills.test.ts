import { describe, expect, it } from 'vitest';
import { ensureRuntimePolyfills } from './runtime-polyfills';

type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => PromiseResolvers<T>;
};

describe('runtime polyfills', () => {
  it('installs Promise.withResolvers when the runtime does not provide it', async () => {
    const promiseCtor = Promise as PromiseConstructorWithResolvers;
    const original = promiseCtor.withResolvers;

    try {
      promiseCtor.withResolvers = undefined;

      ensureRuntimePolyfills();

      expect(typeof promiseCtor.withResolvers).toBe('function');
      const missingWithResolvers = <T>(): PromiseResolvers<T> => {
        throw new Error('Promise.withResolvers was not installed');
      };
      const withResolvers =
        promiseCtor.withResolvers ?? missingWithResolvers;

      const { promise, resolve } = withResolvers<string>();
      resolve('ok');

      await expect(promise).resolves.toBe('ok');
    } finally {
      promiseCtor.withResolvers = original;
    }
  });
});
