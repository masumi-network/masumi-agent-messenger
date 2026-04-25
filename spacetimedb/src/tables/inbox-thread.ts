import { table, t } from 'spacetimedb/server';

export const inboxThreadTable = table(
    {
      name: 'inbox_thread',
      indexes: [],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      threadId: t.u64(),
      uniqueKey: t.string(),
      sortKey: t.string(),
      lastMessageAt: t.timestamp(),
      lastMessageSeq: t.u64(),
      updatedAt: t.timestamp(),
    }
);
