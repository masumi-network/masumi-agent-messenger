import spacetimedb from '../../schema';
import { rateLimitCleanupTable } from '../../tables/rate-limit-cleanup';

import * as model from '../../model';

const {
  isTimestampExpired,
  requireScheduledReducerCall,
  reportRateLimitBucket,
} = model;
export const expireRateLimitBucket = spacetimedb.reducer(
  { arg: rateLimitCleanupTable.rowType },
  (ctx, { arg }) => {
    requireScheduledReducerCall(ctx);

    const bucket = ctx.db.rateLimit.bucketKey.find(arg.bucketKey);
    ctx.db.rateLimitCleanup.delete(arg);
    if (!bucket) {
      return;
    }
    if (
      bucket.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(bucket.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    reportRateLimitBucket(ctx, bucket, ctx.timestamp);
    ctx.db.rateLimit.id.delete(bucket.id);
  }
);
