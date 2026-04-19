import { timestampToLocaleString } from '../../../shared/spacetime-time';

export function formatTimestamp(ts: { microsSinceUnixEpoch: bigint }): string {
  return timestampToLocaleString(ts);
}
