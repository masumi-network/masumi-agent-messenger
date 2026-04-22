import { table, t } from 'spacetimedb/server';

export const directThreadIndexTable = table(
    {
      name: 'direct_thread_index',
      indexes: [
        {
          accessor: 'direct_thread_index_direct_key',
          algorithm: 'btree',
          columns: ['directKey'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      directKey: t.string(),
      threadId: t.u64().unique(),
      createdAt: t.timestamp(),
    }
);
