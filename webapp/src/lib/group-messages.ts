import { isSameDay } from './format-relative-time';

const FIVE_MINUTES = 5 * 60 * 1000;

type Comparable = {
  senderId: string;
  createdAtMs: number;
};

/**
 * Given a list of message-like items sorted ascending by createdAtMs, compute
 * whether each one should be visually grouped with the previous message (same
 * sender, within a short time window, same calendar day).
 */
export function computeGroupedFlags<T extends Comparable>(items: T[]): boolean[] {
  return items.map((item, index) => {
    if (index === 0) return false;
    const previous = items[index - 1];
    if (!previous) return false;
    if (previous.senderId !== item.senderId) return false;
    if (!isSameDay(previous.createdAtMs, item.createdAtMs)) return false;
    return item.createdAtMs - previous.createdAtMs <= FIVE_MINUTES;
  });
}

/**
 * Returns true if the message at `index` begins a new calendar day compared to
 * the previous message. The first message always starts a new day.
 */
export function computeDayBoundaries<T extends { createdAtMs: number }>(
  items: T[]
): boolean[] {
  return items.map((item, index) => {
    if (index === 0) return true;
    const previous = items[index - 1];
    if (!previous) return true;
    return !isSameDay(previous.createdAtMs, item.createdAtMs);
  });
}
