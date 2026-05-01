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
        {
          accessor: 'message_thread_id_thread_seq',
          algorithm: 'btree',
          columns: ['threadId', 'threadSeq'],
        },
        {
          accessor: 'message_sender_agent_db_id_thread_id_secret_version',
          algorithm: 'btree',
          columns: ['senderAgentDbId', 'threadId', 'secretVersion'],
        },
        {
          accessor: 'message_sender_agent_db_id_thread_id_membership_version_secret_version',
          algorithm: 'btree',
          columns: ['senderAgentDbId', 'threadId', 'membershipVersion', 'secretVersion'],
        },
        {
          // Used by sendEncryptedMessage to reject replays of the same
          // (sender, senderMessageId) pair. Not unique because legacy rows
          // share the sentinel value (`0n` / `1n`); the reducer skips the
          // check for sentinels.
          accessor: 'message_sender_agent_db_id_sender_message_id',
          algorithm: 'btree',
          columns: ['senderAgentDbId', 'senderMessageId'],
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
      // Additive: per-sender opaque message id (random u64). Server-side
      // replay protection lands once a unique index is added in a follow-up
      // publish. `senderSeq` is deprecated and no longer enforced.
      // The default `1n` is a sentinel marking legacy rows (the SDK silently
      // drops a `0n` default because of a falsy check on `defaultValue`).
      // Clients treat both `0n` and `1n` as "unset" when building the
      // signature payload; new sends always pick a random value > 1n.
      senderMessageId: t.u64().default(1n),
    }
);
