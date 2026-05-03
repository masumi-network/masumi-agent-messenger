//! `thread_secret_envelope` — wrapped sender secret per recipient.
//!
//! One row per `(thread, sender, recipient, secret_version)` tuple. When membership changes,
//! the next sender rotates their secret and writes a fresh envelope set; the message that
//! attaches the new envelopes carries `attaches_new_envelopes = true`.
//!
//! Drops `unique_key` synthetic. Reducer enforces uniqueness on
//! `(thread_id, membership_version, sender_agent_db_id, recipient_agent_db_id, secret_version)`
//! via pre-insert lookup using the 3-col index.
//!
//! Versions are all `u32` (were strings in old schema). `wrap_algorithm` is a native enum.

use spacetimedb::Timestamp;

use crate::constants::ThreadSecretWrapAlgorithm;

#[spacetimedb::table(accessor = thread_secret_envelope,
    index(accessor = thread_secret_envelope_thread_id, btree(columns = [thread_id])),
    index(accessor = thread_secret_envelope_thread_id_membership_version,
          btree(columns = [thread_id, membership_version])),
    index(accessor = thread_secret_envelope_thread_id_membership_version_secret_version,
          btree(columns = [thread_id, membership_version, secret_version])),
    index(accessor = thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version,
          btree(columns = [thread_id, membership_version, sender_agent_db_id, secret_version])),
    index(accessor = thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version_id,
          btree(columns = [thread_id, membership_version, sender_agent_db_id, secret_version, id])),
    index(accessor = thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_recipient_agent_db_id_secret_version,
          btree(columns = [thread_id, membership_version, sender_agent_db_id, recipient_agent_db_id, secret_version])),
    index(accessor = thread_secret_envelope_thread_id_membership_version_id,
          btree(columns = [thread_id, membership_version, id])),
    index(accessor = thread_secret_envelope_thread_id_id, btree(columns = [thread_id, id])),
    index(accessor = thread_secret_envelope_thread_id_recipient_agent_db_id_secret_version,
          btree(columns = [thread_id, recipient_agent_db_id, secret_version])),
    index(accessor = thread_secret_envelope_thread_id_recipient_agent_db_id_secret_version_id,
          btree(columns = [thread_id, recipient_agent_db_id, secret_version, id])),
    index(accessor = thread_secret_envelope_thread_id_sender_agent_db_id_id,
          btree(columns = [thread_id, sender_agent_db_id, id])),
    index(accessor = thread_secret_envelope_thread_id_recipient_agent_db_id_id,
          btree(columns = [thread_id, recipient_agent_db_id, id])),
    index(accessor = thread_secret_envelope_thread_id_sender_account_id_id,
          btree(columns = [thread_id, sender_account_id, id])),
    index(accessor = thread_secret_envelope_thread_id_recipient_account_id_id,
          btree(columns = [thread_id, recipient_account_id, id])),
    index(accessor = thread_secret_envelope_sender_agent_db_id_sender_encryption_key_version,
          btree(columns = [sender_agent_db_id, sender_encryption_key_version])),
    index(accessor = thread_secret_envelope_sender_agent_db_id_signing_key_version,
          btree(columns = [sender_agent_db_id, signing_key_version])),
    index(accessor = thread_secret_envelope_recipient_agent_db_id_recipient_encryption_key_version,
          btree(columns = [recipient_agent_db_id, recipient_encryption_key_version])),
)]
#[derive(Debug, Clone)]
pub struct ThreadSecretEnvelope {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,
    pub membership_version: u64,
    pub secret_version: u32,

    pub sender_agent_db_id: u64,
    pub recipient_agent_db_id: u64,
    pub sender_account_id: u64,
    pub recipient_account_id: u64,

    pub sender_encryption_key_version: u32,
    pub recipient_encryption_key_version: u32,
    pub signing_key_version: u32,

    pub wrapped_secret_ciphertext: Vec<u8>,
    pub wrapped_secret_iv: Vec<u8>,
    pub signature: Vec<u8>,

    pub wrap_algorithm: ThreadSecretWrapAlgorithm,

    /// Append-only in normal use; `updated_at == created_at` at insert.
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
