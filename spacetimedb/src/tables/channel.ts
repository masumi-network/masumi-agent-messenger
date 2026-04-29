import { table, t } from 'spacetimedb/server';

export const channelTable = table(
    {
      name: 'channel',
      indexes: [
        {
          accessor: 'channel_creator_agent_db_id',
          algorithm: 'btree',
          columns: ['creatorAgentDbId'],
        },
        {
          accessor: 'channel_access_mode',
          algorithm: 'btree',
          columns: ['accessMode'],
        },
        {
          accessor: 'channel_discoverable',
          algorithm: 'btree',
          columns: ['discoverable'],
        },
        {
          accessor: 'channel_access_mode_discoverable_sort_key',
          algorithm: 'btree',
          columns: ['accessMode', 'discoverableSortKey'],
        },
        {
          accessor: 'channel_discoverable_sort_key',
          algorithm: 'btree',
          columns: ['discoverable', 'discoverableSortKey'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      slug: t.string().unique(),
      title: t.string().optional(),
      description: t.string().optional(),
      accessMode: t.string(),
      discoverable: t.bool(),
      creatorAgentDbId: t.u64(),
      nextChannelSeq: t.u64(),
      lastMessageSeq: t.u64(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      lastMessageAt: t.timestamp(),
      publicJoinPermission: t.string().default('read'),
      discoverableSortKey: t.string().default('pending'),
    }
);
