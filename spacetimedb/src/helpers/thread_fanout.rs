//! Thread participant fan-out — bump `updated_at` on all `active` participants of a thread.
//!
//! Drives the actor-scoped recency index on `thread_participant`, which powers
//! `listVisibleThreads(afterSortKey?, limit)`.
//!
//! **Fan-out scope (per plan "Reducer fan-out contract")**:
//! - `send_encrypted_message`: fans out
//! - `add_thread_participant` / `remove_thread_participant` / `set_thread_participant_admin`: fans out
//! - `accept_thread_invite`: fans out
//! - `update_thread_read_state` / `decline_thread_invite`: caller-only — do NOT call this
//!
//! Capped by `MAX_THREAD_FANOUT = 50` (the participant count is itself capped, so fan-out is
//! O(participants) ≤ 50 per call).

use spacetimedb::ReducerContext;

use crate::helpers::account_signals::bump_thread_list_signal;
use crate::helpers::threads::thread_participant_recency_sort_key;
use crate::tables::*;

/// Bumps `updated_at` on every `active` participant of `thread_id`. Callers must be the set
/// of "thread-activity" reducers listed above.
pub fn bump_active_participants(ctx: &ReducerContext, thread_id: u64) {
    let now = ctx.timestamp;
    let table = ctx.db.thread_participant();
    let to_update: Vec<ThreadParticipant> = table
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .collect();
    for p in to_update {
        bump_thread_list_signal(ctx, p.account_id);
        let updated = ThreadParticipant {
            updated_at: now,
            active_recency_sort_key: thread_participant_recency_sort_key(true, now),
            ..p
        };
        table.id().update(updated);
    }
}
