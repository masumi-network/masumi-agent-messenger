export type TimestampLike = {
  microsSinceUnixEpoch: bigint;
};

type TimestampWithDate = TimestampLike & {
  toDate?: () => Date;
};

function readMicros(value: TimestampLike): bigint {
  return value.microsSinceUnixEpoch;
}

export function compareTimestamps(left: TimestampLike, right: TimestampLike): number {
  if (readMicros(left) < readMicros(right)) return -1;
  if (readMicros(left) > readMicros(right)) return 1;
  return 0;
}

export function compareTimestampsDesc(left: TimestampLike, right: TimestampLike): number {
  return compareTimestamps(right, left);
}

export function timestampToDate(value: TimestampLike | null | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const maybeTimestamp = value as TimestampWithDate;
  if ('toDate' in maybeTimestamp && typeof maybeTimestamp.toDate === 'function') {
    return maybeTimestamp.toDate();
  }

  return new Date(Number(value.microsSinceUnixEpoch / 1000n));
}

export function timestampToISOString(value: TimestampLike): string {
  return timestampToDate(value)?.toISOString() ?? '';
}

export function isTimestampInFuture(
  value: TimestampLike | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!value) {
    return false;
  }
  return value.microsSinceUnixEpoch > BigInt(nowMs) * 1000n;
}

export function timestampToLocaleString(value: TimestampLike): string {
  return timestampToDate(value)?.toLocaleString() ?? '';
}
