import { useCallback, useSyncExternalStore } from 'react';

const KEY_PREFIX = 'masumi:draft:v1:';

function keyFor(slug: string | null | undefined, threadId: string | null | undefined): string | null {
  if (!slug || !threadId) return null;
  return `${KEY_PREFIX}${encodeURIComponent(slug)}:${encodeURIComponent(threadId)}`;
}

function readDraft(key: string | null): string {
  if (!key) return '';
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string | null, value: string): void {
  if (!key) return;
  if (typeof window === 'undefined') return;
  try {
    if (value === '') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // swallow quota / disabled storage errors
  }
}

const draftListeners = new Set<() => void>();

function emitDraftChange(): void {
  for (const listener of draftListeners) {
    listener();
  }
}

function subscribeToDraftChanges(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

export function useDraftStore(
  slug: string | null | undefined,
  threadId: string | null | undefined
): {
  value: string;
  setValue: (next: string) => void;
  clear: () => void;
} {
  const storageKey = keyFor(slug, threadId);
  const value = useSyncExternalStore(
    subscribeToDraftChanges,
    () => readDraft(storageKey),
    () => ''
  );

  const setValue = useCallback(
    (next: string) => {
      writeDraft(storageKey, next);
      emitDraftChange();
    },
    [storageKey]
  );

  const clear = useCallback(() => {
    setValue('');
  }, [setValue]);

  return { value, setValue, clear };
}
