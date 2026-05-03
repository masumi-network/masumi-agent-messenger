//! `message` — end-to-end encrypted thread message.
//!
//! Drops:
//! - 4-/5-column compound indexes on sender/membership/secret (replaced by smaller indexes plus
//!   code-level filters)
//!
//! `secret_version` and `signing_key_version` are `u32` (were strings in old schema).
//! `cipher_algorithm` is a native enum.
//!
//! `attaches_new_envelopes` (renamed from `secret_version_start`): when true, this message is
//! the rotation boundary for a fresh `secret_version`; the corresponding envelope set must
//! exist on `thread_secret_envelope` for all active participants.
//!
//! **Reply integrity**: `sendEncryptedMessage` validates that `reply_to_message_id` (if set)
//! refers to a message in the **same thread**. The referenced message is not required to still
//! exist — references can become dangling if the parent is later deleted.

use spacetimedb::Timestamp;

use crate::constants::MessageCipherAlgorithm;

#[spacetimedb::table(accessor = message,
    index(accessor = message_thread_id, btree(columns = [thread_id])),
    index(accessor = message_thread_id_id, btree(columns = [thread_id, id])),
    index(accessor = message_thread_id_id_desc_sort_key,
          btree(columns = [thread_id, id_desc_sort_key])),
    index(accessor = message_thread_id_membership_version_id_desc_sort_key,
          btree(columns = [thread_id, membership_version, id_desc_sort_key])),
    index(accessor = message_thread_id_attaches_new_envelopes_id,
          btree(columns = [thread_id, attaches_new_envelopes, id])),
    index(accessor = message_sender_agent_db_id_sender_message_id,
          btree(columns = [sender_agent_db_id, sender_message_id])),
    index(accessor = message_sender_agent_db_id_signing_key_version,
          btree(columns = [sender_agent_db_id, signing_key_version])),
)]
#[derive(Debug, Clone)]
pub struct Message {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,
    /// `u64::MAX - id`, filled immediately after insert. Lets procedures page
    /// newest-first with a forward btree scan.
    pub id_desc_sort_key: u64,

    pub sender_agent_db_id: u64,

    /// Random opaque u64 chosen by the sender. Reducer rejects collisions on
    /// `(sender_agent_db_id, sender_message_id)` via the 2-col btree above (replay protection).
    pub sender_message_id: u64,

    pub secret_version: u32,

    /// Renamed from `secret_version_start`. When true, this message attaches a fresh envelope
    /// set; recipients must use the new `secret_version` for subsequent messages.
    pub attaches_new_envelopes: bool,

    pub membership_version: u64,

    pub signing_key_version: u32,

    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
    pub signature: Vec<u8>,

    pub cipher_algorithm: MessageCipherAlgorithm,

    pub reply_to_message_id: Option<u64>,

    /// Append-only in normal use; `updated_at == created_at` at insert.
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
