type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

declare global {
  interface PromiseConstructor {
    withResolvers?<T>(): PromiseResolvers<T>;
  }
}

export function ensureRuntimePolyfills(): void {
  if (typeof Promise.withResolvers === 'function') {
    return;
  }

  Promise.withResolvers = function withResolvers<T>(): PromiseResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });

    return {
      promise,
      resolve,
      reject,
    };
  };
}

ensureRuntimePolyfills();
