export function deferEffectStateUpdate(callback: () => void): () => void {
  let cancelled = false;

  const run = () => {
    if (!cancelled) {
      callback();
    }
  };

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(run);
  } else {
    void Promise.resolve().then(run);
  }

  return () => {
    cancelled = true;
  };
}
