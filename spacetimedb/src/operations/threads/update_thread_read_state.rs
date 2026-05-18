//! `update_thread_read_state` — combines `markThreadRead` + `setThreadArchived`.
//!
//! **Caller-only — does NOT fan out**. `thread_participant.updated_at` is the per-account inbox
//! recency key, so read/archive-only writes intentionally preserve it.

use spacetimedb::ReducerContext;

use crate::helpers::account_signals::bump_thread_list_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::threads::require_active_thread_participant;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_thread_read_state(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    last_read_message_id: Option<u64>,
    archived: Option<bool>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    if ctx.db.thread().id().find(&thread_id).is_none() {
        return Err("Thread not found".to_string());
    }
    let participant = require_active_thread_participant(ctx, thread_id, actor.id)?;
    if let Some(read_message_id) = last_read_message_id {
        if read_message_id > 0 {
            let Some(message) = ctx.db.message().id().find(&read_message_id) else {
                return Err("lastReadMessageId message not found".to_string());
            };
            if message.thread_id != thread_id {
                return Err("lastReadMessageId is not in this thread".to_string());
            }
        }
    }

    let previous_last_read = participant.last_read_message_id;
    let new_last_read = match last_read_message_id {
        None => previous_last_read,
        Some(id) => id.max(previous_last_read),
    };
    let new_archived = archived.unwrap_or(participant.archived);

    if new_last_read == previous_last_read && new_archived == participant.archived {
        return Ok(());
    }

    let updated = ThreadParticipant {
        last_read_message_id: new_last_read,
        archived: new_archived,
        ..participant
    };
    ctx.db.thread_participant().id().update(updated);
    bump_thread_list_signal(ctx, account.id);

    Ok(())
}
