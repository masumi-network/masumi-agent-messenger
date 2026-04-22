import { table, t } from 'spacetimedb/server';

export const channelJoinRequestTable = table(
    {
      name: 'channel_join_request',
      indexes: [
        {
          accessor: 'channel_join_request_channel_id',
          algorithm: 'btree',
          columns: ['channelId'],
        },
        {
          accessor: 'channel_join_request_requester_agent_db_id',
          algorithm: 'btree',
          columns: ['requesterAgentDbId'],
        },
        {
          accessor: 'channel_join_request_requester_inbox_id',
          algorithm: 'btree',
          columns: ['requesterInboxId'],
        },
        {
          accessor: 'channel_join_request_status',
          algorithm: 'btree',
          columns: ['status'],
        },
        {
          accessor: 'channel_join_request_channel_id_status',
          algorithm: 'btree',
          columns: ['channelId', 'status'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      channelId: t.u64(),
      requesterAgentDbId: t.u64(),
      requesterInboxId: t.u64(),
      uniqueKey: t.string().unique(),
      permission: t.string(),
      status: t.string(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      resolvedAt: t.timestamp().optional(),
      resolvedByAgentDbId: t.u64().optional(),
    }
);
