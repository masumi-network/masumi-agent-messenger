import { table, t } from 'spacetimedb/server';

export const channelMemberTable = table(
    {
      name: 'channel_member',
      indexes: [
        {
          accessor: 'channel_member_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'channel_member_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'channel_member_channel_id_id',
          algorithm: 'btree',
          columns: ['channelId', 'id'],
        },
        {
          accessor: 'channel_member_channel_id_permission_active',
          algorithm: 'btree',
          columns: ['channelId', 'permission', 'active'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      channelId: t.u64(),
      agentDbId: t.u64(),
      inboxId: t.u64(),
      uniqueKey: t.string().unique(),
      permission: t.string(),
      active: t.bool(),
      lastSentSeq: t.u64(),
      joinedAt: t.timestamp(),
      updatedAt: t.timestamp(),
    }
);
