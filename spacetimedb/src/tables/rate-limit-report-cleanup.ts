import { table, t } from 'spacetimedb/server';

import { getScheduledReducer } from '../scheduled';

export const rateLimitReportCleanupTable = table(
  {
    name: 'rate_limit_report_cleanup',
    indexes: [
      {
        accessor: 'rate_limit_report_cleanup_report_id',
        algorithm: 'btree',
        columns: ['reportId'],
      },
    ],
    scheduled: (): any => getScheduledReducer('expireRateLimitReport'),
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    reportId: t.u64(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);
