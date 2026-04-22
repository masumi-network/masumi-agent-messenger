import { table, t } from 'spacetimedb/server';

import { getScheduledReducer } from '../scheduled';

export const rateLimitCleanupTable = table(
  {
    name: 'rate_limit_cleanup',
    indexes: [
      {
        accessor: 'rate_limit_cleanup_bucket_key',
        algorithm: 'btree',
        columns: ['bucketKey'],
      },
    ],
    scheduled: (): any => getScheduledReducer('expireRateLimitBucket'),
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    bucketKey: t.string(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);
