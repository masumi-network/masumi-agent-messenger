const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;

function toMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function formatRelativeTime(
  value: Date | number | string,
  now: Date | number = Date.now()
): string {
  const timestamp = toMs(value);
  const reference = toMs(now);
  const diff = reference - timestamp;

  if (diff < ONE_MINUTE) return 'just now';
  if (diff < ONE_HOUR) {
    const mins = Math.floor(diff / ONE_MINUTE);
    return `${mins}m`;
  }
  if (diff < ONE_DAY) {
    const hours = Math.floor(diff / ONE_HOUR);
    return `${hours}h`;
  }
  if (diff < ONE_WEEK) {
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: 'short',
    });
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatDayLabel(
  value: Date | number | string,
  now: Date | number = Date.now()
): string {
  const timestamp = toMs(value);
  const today = startOfDay(toMs(now));
  const day = startOfDay(timestamp);
  const diffDays = Math.round((today - day) / ONE_DAY);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) {
    return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'long' });
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: diffDays > 365 ? 'numeric' : undefined,
  });
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}
