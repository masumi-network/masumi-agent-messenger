//! `remove_thread_participant` — admin removes a participant. Fan-out reducer.
//!
//! After the removal the caller is also removable; if the last admin steps down, an automatic
//! replacement admin is promoted (lowest-id active participant).

use spacetimedb::ReducerContext;

use crate::constants::ThreadKind;
use crate::helpers::account_signals::bump_thread_list_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::retention::schedule_thread_secret_envelope_gc;
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{
    decrement_active_participant_count, get_thread_participant, promote_replacement_admin,
    require_active_thread_participant, require_admin_thread_participant,
    thread_participant_recency_sort_key,
};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn remove_thread_participant(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    target_agent_db_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;
    let thread = ctx
        .db
        .thread()
        .id()
        .find(&thread_id)
        .ok_or_else(|| "Thread not found".to_string())?;
    if matches!(thread.kind, ThreadKind::Direct) {
        return Err(
            "Cannot remove participants from a direct thread; cancel a pending request or delete the direct thread"
                .to_string(),
        );
    }

    if actor.id == target_agent_db_id {
        // Self-removal: must be an active participant.
        require_active_thread_participant(ctx, thread_id, actor.id)?;
    } else {
        require_admin_thread_participant(ctx, thread_id, actor.id)?;
    }

    let target = get_thread_participant(ctx, thread_id, target_agent_db_id)
        .ok_or_else(|| "Target is not a participant of this thread".to_string())?;
    if !target.active {
        return Ok(());
    }
    let target_account_id = target.account_id;

    let updated = ThreadParticipant {
        active: false,
        is_admin: false,
        updated_at: ctx.timestamp,
        active_recency_sort_key: thread_participant_recency_sort_key(false, ctx.timestamp),
        ..target
    };
    ctx.db.thread_participant().id().update(updated);
    bump_thread_list_signal(ctx, target_account_id);

    let bumped = Thread {
        membership_version: thread.membership_version + 1,
        updated_at: ctx.timestamp,
        ..thread
    };
    ctx.db.thread().id().update(bumped);
    decrement_active_participant_count(ctx, thread_id);

    promote_replacement_admin(ctx, thread_id);
    bump_active_participants(ctx, thread_id);
    schedule_thread_secret_envelope_gc(ctx, thread_id);
    Ok(())
}
