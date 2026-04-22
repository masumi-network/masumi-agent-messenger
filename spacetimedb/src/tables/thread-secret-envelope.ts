import { table, t } from 'spacetimedb/server';

export const threadSecretEnvelopeTable = table(
    {
      name: 'thread_secret_envelope',
      indexes: [
        {
          accessor: 'thread_secret_envelope_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'thread_secret_envelope_recipient_agent_db_id',
          algorithm: 'btree',
          columns: ['recipientAgentDbId'],
        },
        {
          accessor: 'thread_secret_envelope_sender_agent_db_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      membershipVersion: t.u64(),
      secretVersion: t.string(),
      senderAgentDbId: t.u64(),
      recipientAgentDbId: t.u64(),
      uniqueKey: t.string().unique(),
      senderEncryptionKeyVersion: t.string(),
      recipientEncryptionKeyVersion: t.string(),
      signingKeyVersion: t.string(),
      wrappedSecretCiphertext: t.string(),
      wrappedSecretIv: t.string(),
      wrapAlgorithm: t.string(),
      signature: t.string(),
      createdAt: t.timestamp(),
    }
);
