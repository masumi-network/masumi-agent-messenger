import { table, t } from 'spacetimedb/server';

export const publicRecentChannelMessageTable = table(
    {
      name: 'public_recent_channel_message',
      indexes: [
        {
          accessor: 'public_recent_channel_message_channel_id',
          algorithm: 'btree',
          columns: ['channelId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      channelId: t.u64(),
      channelSeq: t.u64(),
      channelSeqKey: t.string().unique(),
      senderAgentDbId: t.u64(),
      senderPublicIdentity: t.string(),
      senderSeq: t.u64(),
      senderSigningKeyVersion: t.string(),
      plaintext: t.string(),
      signature: t.string(),
      replyToMessageId: t.u64().optional(),
      createdAt: t.timestamp(),
    }
);
