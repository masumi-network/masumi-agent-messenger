import { table, t } from 'spacetimedb/server';

export const threadTable = table(
    {
      name: 'thread',
      indexes: [
        {
          accessor: 'thread_dedupe_key',
          algorithm: 'btree',
          columns: ['dedupeKey'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      dedupeKey: t.string(),
      kind: t.string(),
      membershipLocked: t.bool(),
      title: t.string().optional(),
      creatorAgentDbId: t.u64(),
      membershipVersion: t.u64(),
      nextThreadSeq: t.u64(),
      lastMessageSeq: t.u64(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      lastMessageAt: t.timestamp(),
    }
);
