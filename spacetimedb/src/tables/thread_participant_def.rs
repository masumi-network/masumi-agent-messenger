//! `thread_participant` — membership row for a thread, with read-state merged in.
//!
//! Absorbs `last_read_message_id` and `archived` from the dropped `thread_read_state` table.
//! Drops `unique_key` synthetic; reducer enforces `(thread_id, agent_db_id)` uniqueness via
//! pre-insert lookup on the 2-col btree below.
//!
//! **Fan-out contract** (per plan): thread-activity reducers (`send_encrypted_message`,
//! `add_thread_participant`, `remove_thread_participant`, `set_thread_participant_admin`,
//! `accept_thread_invite`) bump `updated_at` on **all active** participant rows. Caller-only
//! read/archive updates preserve `updated_at` so they do not affect inbox recency. Thread-list
//! procedures page with the `(agent_db_id, active_recency_sort_key, id)` index.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = thread_participant,
    index(accessor = thread_participant_thread_id, btree(columns = [thread_id])),
    index(accessor = thread_participant_thread_id_active, btree(columns = [thread_id, active])),
    index(accessor = thread_participant_account_id, btree(columns = [account_id])),
    index(accessor = thread_participant_account_id_active, btree(columns = [account_id, active])),
    index(accessor = thread_participant_account_id_active_updated_at,
          btree(columns = [account_id, active, updated_at])),
    index(accessor = thread_participant_account_id_active_recency_sort_key,
          btree(columns = [account_id, active_recency_sort_key])),
    index(accessor = thread_participant_agent_db_id_active_recency_sort_key_id,
          btree(columns = [agent_db_id, active_recency_sort_key, id])),
    index(accessor = thread_participant_thread_id_agent_db_id, btree(columns = [thread_id, agent_db_id])),
    index(accessor = thread_participant_thread_id_account_id_active,
          btree(columns = [thread_id, account_id, active])),
    index(accessor = thread_participant_thread_id_id, btree(columns = [thread_id, id])),
    index(accessor = thread_participant_thread_id_active_id, btree(columns = [thread_id, active, id])),
)]
#[derive(Debug, Clone)]
pub struct ThreadParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,
    pub agent_db_id: u64,
    pub account_id: u64,

    /// Membership version at which this participant's current active window began. Reads are
    /// bounded by this floor, so remove/re-add does not reveal messages from the inactive gap.
    pub membership_version: u64,

    pub last_sent_seq: u64,

    /// Default `0` = "never sent". `secret_version` starts at 1, so 0 is a safe sentinel —
    /// matches the parallel pattern on `last_read_message_id`.
    pub last_sent_secret_version: u32,

    /// Default `0` = "never read" (autoIncrement message id starts at 1, so 0 is safe sentinel).
    /// Was optional in old schema; dropped optional per type-improvements.
    pub last_read_message_id: u64,

    /// Default `false`. Merged from the dropped `thread_read_state` table.
    pub archived: bool,

    pub is_admin: bool,
    pub active: bool,
    /// `-updated_at` while active; `i64::MAX` while inactive. This lets visible thread
    /// windows page newest-first with a forward btree scan.
    pub active_recency_sort_key: i64,

    /// Replaces old `joined_at` (renamed for naming consistency across the schema).
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
