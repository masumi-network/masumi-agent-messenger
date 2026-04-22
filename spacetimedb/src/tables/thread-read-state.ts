import { table, t } from 'spacetimedb/server';

export const threadReadStateTable = table(
    {
      name: 'thread_read_state',
      indexes: [
        {
          accessor: 'thread_read_state_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'thread_read_state_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      agentDbId: t.u64(),
      uniqueKey: t.string().unique(),
      lastReadThreadSeq: t.u64().optional(),
      archived: t.bool(),
      updatedAt: t.timestamp(),
    }
);
