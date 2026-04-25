import { table, t } from 'spacetimedb/server';

export const inboxThreadBackfillTable = table(
    {
      name: 'inbox_thread_backfill',
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      nextParticipantId: t.u64(),
      complete: t.bool(),
      updatedAt: t.timestamp(),
    }
);
