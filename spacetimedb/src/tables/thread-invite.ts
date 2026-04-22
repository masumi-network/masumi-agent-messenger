import { table, t } from 'spacetimedb/server';

export const threadInviteTable = table(
    {
      name: 'thread_invite',
      indexes: [
        {
          accessor: 'thread_invite_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_invite_invitee_agent_db_id',
          algorithm: 'btree',
          columns: ['inviteeAgentDbId'],
        },
        {
          accessor: 'thread_invite_invitee_inbox_id',
          algorithm: 'btree',
          columns: ['inviteeInboxId'],
        },
        {
          accessor: 'thread_invite_inviter_agent_db_id',
          algorithm: 'btree',
          columns: ['inviterAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      inviterAgentDbId: t.u64(),
      inviteeAgentDbId: t.u64(),
      inviteeInboxId: t.u64(),
      uniqueKey: t.string().unique(),
      status: t.string(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      resolvedAt: t.timestamp().optional(),
      resolvedByAgentDbId: t.u64().optional(),
    }
);
