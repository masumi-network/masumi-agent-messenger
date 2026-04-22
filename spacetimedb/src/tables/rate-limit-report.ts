import { table, t } from 'spacetimedb/server';

export const rateLimitReportTable = table(
    {
      name: 'rate_limit_report',
      indexes: [
        {
          accessor: 'rate_limit_report_bucket_key',
          algorithm: 'btree',
          columns: ['bucketKey'],
        },
        {
          accessor: 'rate_limit_report_owner_identity',
          algorithm: 'btree',
          columns: ['ownerIdentity'],
        },
        {
          accessor: 'rate_limit_report_action',
          algorithm: 'btree',
          columns: ['action'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      reportKey: t.string().unique(),
      bucketKey: t.string(),
      action: t.string(),
      ownerIdentity: t.identity(),
      windowStart: t.timestamp(),
      windowExpiresAt: t.timestamp(),
      allowedCount: t.u64(),
      limitedCount: t.u64(),
      firstLimitedAt: t.timestamp().optional(),
      lastLimitedAt: t.timestamp().optional(),
      reportedAt: t.timestamp(),
      expiresAt: t.timestamp(),
    }
);
