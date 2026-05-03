//! `thread` — encrypted conversation container.
//!
//! Direct threads carry a sorted `(direct_low_agent_db_id, direct_high_agent_db_id)` pair for
//! efficient peer-pair lookup. Multiple Direct threads may share the same pair; Group threads
//! leave both fields `0` (sentinel — agent autoinc ids start at 1).
//!
//! `kind` is a native enum (was string in old schema). Per-thread message sequence counters are
//! dropped; message history pages use auto-increment `message.id` cursors. Direct threads created
//! with an attached first message intentionally use a client-generated `id` because the client
//! signs the stable thread id before reducers run; all server-assigned thread inserts still use
//! the `0` auto-inc placeholder.

use spacetimedb::Timestamp;

use crate::constants::ThreadKind;

#[spacetimedb::table(accessor = thread,
    index(accessor = thread_direct_pair,
          btree(columns = [direct_low_agent_db_id, direct_high_agent_db_id])),
)]
#[derive(Debug, Clone)]
pub struct Thread {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub kind: ThreadKind,

    /// Sorted pair for `kind = Direct`; both `0` for `kind = Group`. Reducers enforce that
    /// `direct_low < direct_high`; multiple Direct threads may share the same pair.
    pub direct_low_agent_db_id: u64,
    pub direct_high_agent_db_id: u64,

    pub title: Option<String>,

    pub creator_agent_db_id: u64,

    pub membership_version: u64,

    pub active_participant_count: u64,

    /// Latest auto-increment `message.id` for this thread, or `0` before the first message.
    /// This is a read cursor hint, not a per-thread allocator.
    pub last_message_id: u64,

    /// Display-only count of messages in the thread. Message ordering and cursors use
    /// auto-increment `message.id`.
    pub message_count: u64,

    pub last_message_at: Timestamp,

    /// Optional per-thread encrypted-message TTL in milliseconds. `None` retains messages
    /// indefinitely.
    pub message_retention_ms: Option<u64>,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
