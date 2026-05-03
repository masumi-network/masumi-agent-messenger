//! `channel_message` — signed plaintext channel message.
//!
//! Private table (not `public: true`). Members read via the `listChannelMessages` procedure
//! (filtered by membership). Anonymous viewers fetch history via the `listPublicChannelMessages`
//! procedure, which gates reads on `channel.access_mode = Public`.
//!
//! `sender_signing_key_version` is `u32` (was string).

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_message,
    index(accessor = channel_message_channel_id, btree(columns = [channel_id])),
    index(accessor = channel_message_channel_id_id,
          btree(columns = [channel_id, id])),
    index(accessor = channel_message_channel_id_id_desc_sort_key,
          btree(columns = [channel_id, id_desc_sort_key])),
    index(accessor = channel_message_sender_agent_db_id_sender_message_id,
          btree(columns = [sender_agent_db_id, sender_message_id])),
    index(accessor = channel_message_sender_agent_db_id_sender_signing_key_version,
          btree(columns = [sender_agent_db_id, sender_signing_key_version])),
)]
#[derive(Debug, Clone)]
pub struct ChannelMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub channel_id: u64,
    /// `u64::MAX - id`, filled immediately after insert. Lets procedures page
    /// newest-first with a forward btree scan.
    pub id_desc_sort_key: u64,

    pub sender_agent_db_id: u64,
    pub sender_public_identity: String,
    pub sender_signing_key_version: u32,

    /// Random opaque u64 chosen by the sender. Reducer rejects collisions on
    /// `(sender_agent_db_id, sender_message_id)` (replay protection). No sentinel default.
    pub sender_message_id: u64,

    pub plaintext: String,
    pub signature: Vec<u8>,

    /// Validated same-channel on insert; can become dangling if the parent is later deleted.
    pub reply_to_message_id: Option<u64>,

    /// Append-only in normal use.
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
