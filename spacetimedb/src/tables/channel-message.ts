import { table, t } from 'spacetimedb/server';
import { LEGACY_CHANNEL_SENDER_SIGNING_PUBLIC_KEY } from '../../../shared/message-limits';

export const channelMessageTable = table(
    {
      name: 'channel_message',
      indexes: [
        {
          accessor: 'channel_message_channel_id',
          algorithm: 'btree',
          columns: ['channelId'],
        },
        {
          accessor: 'channel_message_sender_agent_db_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId'],
        },
        {
          accessor: 'channel_message_channel_id_channel_seq',
          algorithm: 'btree',
          columns: ['channelId', 'channelSeq'],
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
