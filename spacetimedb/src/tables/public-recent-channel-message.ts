import { table, t } from 'spacetimedb/server';
import { LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY } from '../../../shared/message-limits';

export const publicRecentChannelMessageTable = table(
    {
      name: 'public_recent_channel_message',
      public: true,
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
      senderSigningPublicKey: t.string().default(LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY),
    }
);
