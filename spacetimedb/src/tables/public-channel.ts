import { table, t } from 'spacetimedb/server';

export const publicChannelTable = table(
    {
      name: 'public_channel',
      public: true,
      indexes: [],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      channelId: t.u64().unique(),
      slug: t.string().unique(),
      title: t.string().optional(),
      description: t.string().optional(),
      accessMode: t.string(),
      discoverable: t.bool(),
      lastMessageSeq: t.u64(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      lastMessageAt: t.timestamp(),
    }
);
