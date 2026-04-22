import { table, t } from 'spacetimedb/server';

export const rateLimitTable = table(
    {
      name: 'rate_limit',
    },
    {
      id: t.u64().primaryKey().autoInc(),
      bucketKey: t.string().unique(),
      action: t.string(),
      ownerIdentity: t.identity(),
      windowStart: t.timestamp(),
      expiresAt: t.timestamp(),
      count: t.u64(),
      limitedCount: t.u64(),
      firstLimitedAt: t.timestamp().optional(),
      lastLimitedAt: t.timestamp().optional(),
      updatedAt: t.timestamp(),
    }
);
