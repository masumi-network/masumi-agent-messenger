import { table, t } from 'spacetimedb/server';

export const inboxThreadTable = table(
    {
      name: 'inbox_thread',
      indexes: [
        {
          accessor: 'inbox_thread_inbox_id_sort_key',
          algorithm: 'btree',
          columns: ['inboxId', 'sortKey'],
        },
        {
          accessor: 'inbox_thread_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'inbox_thread_unique_key',
          algorithm: 'btree',
          columns: ['uniqueKey'],
        },
      ],
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
