const KEY_BACKUP_PROMPT_KEY = 'masumi-agent-messenger:key-backup-prompt';

export type PendingKeyBackupPrompt = {
  normalizedEmail: string;
  slug: string;
  reason: 'created';
};

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.sessionStorage;
}

export function queueKeyBackupPrompt(prompt: PendingKeyBackupPrompt): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  storage.setItem(KEY_BACKUP_PROMPT_KEY, JSON.stringify(prompt));
}

export function consumeKeyBackupPrompt(match: {
  normalizedEmail: string;
  slug: string;
}): PendingKeyBackupPrompt | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(KEY_BACKUP_PROMPT_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PendingKeyBackupPrompt;
    if (
      parsed.normalizedEmail !== match.normalizedEmail ||
      parsed.slug !== match.slug
    ) {
      return null;
    }

    storage.removeItem(KEY_BACKUP_PROMPT_KEY);
    return parsed;
  } catch {
    storage.removeItem(KEY_BACKUP_PROMPT_KEY);
    return null;
  }
}
