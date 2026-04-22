import { table, t } from 'spacetimedb/server';

export const messageTable = table(
    {
      name: 'message',
      indexes: [
        {
          accessor: 'message_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'message_sender_agent_db_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      threadSeq: t.u64(),
      threadSeqKey: t.string().unique(),
      membershipVersion: t.u64(),
      senderAgentDbId: t.u64(),
      senderSeq: t.u64(),
      secretVersion: t.string(),
      secretVersionStart: t.bool(),
      signingKeyVersion: t.string(),
      ciphertext: t.string(),
      iv: t.string(),
      cipherAlgorithm: t.string(),
      signature: t.string(),
      replyToMessageId: t.u64().optional(),
      createdAt: t.timestamp(),
    }
);
