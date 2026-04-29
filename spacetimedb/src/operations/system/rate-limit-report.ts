import spacetimedb from '../../schema';
import { rateLimitReportCleanupTable } from '../../tables/rate-limit-report-cleanup';

import * as model from '../../model';

const {
  isTimestampExpired,
  requireScheduledReducerCall,
} = model;
export const expireRateLimitReport = spacetimedb.reducer(
  { arg: rateLimitReportCleanupTable.rowType },
  (ctx, { arg }) => {
    requireScheduledReducerCall(ctx);

    const report = ctx.db.rateLimitReport.id.find(arg.reportId);
    ctx.db.rateLimitReportCleanup.delete(arg);
    if (!report) {
      return;
    }
    if (
      report.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(report.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    ctx.db.rateLimitReport.id.delete(report.id);
  }
);
