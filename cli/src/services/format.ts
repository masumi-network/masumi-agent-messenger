/**
 * Human-readable formatting utilities for CLI output.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const now = Date.now();
  const ms = now - date.getTime();

  if (Number.isNaN(date.getTime())) {
    return String(input);
  }

  if (ms < 0) {
    const future = -ms;
    if (future < MINUTE) return 'in a few seconds';
    if (future < HOUR) return `in ${Math.ceil(future / MINUTE)} min`;
    if (future < DAY) return `in ${Math.floor(future / HOUR)}h ${Math.ceil((future % HOUR) / MINUTE)}m`;
    return `in ${Math.ceil(future / DAY)}d`;
  }

  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (ms < 2 * DAY) return 'yesterday';
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)} days ago`;

  return date.toLocaleDateString();
}
