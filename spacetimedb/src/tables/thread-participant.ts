import { table, t } from 'spacetimedb/server';

export const threadParticipantTable = table(
    {
      name: 'thread_participant',
      indexes: [
        {
          accessor: 'thread_participant_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_participant_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'thread_participant_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'thread_participant_inbox_id_id',
          algorithm: 'btree',
          columns: ['inboxId', 'id'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      agentDbId: t.u64(),
      inboxId: t.u64(),
      uniqueKey: t.string().unique(),
      joinedAt: t.timestamp(),
      lastSentSeq: t.u64(),
      lastSentMembershipVersion: t.u64().optional(),
      lastSentSecretVersion: t.string().optional(),
      isAdmin: t.bool(),
      active: t.bool(),
    }
);
