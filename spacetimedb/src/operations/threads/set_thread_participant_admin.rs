//! `set_thread_participant_admin` — admin grants/revokes admin on another participant.
//! Fan-out reducer.

use spacetimedb::ReducerContext;

use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{
    get_thread_participant, promote_replacement_admin, require_admin_thread_participant,
    require_another_active_thread_admin, thread_participant_recency_sort_key,
};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn set_thread_participant_admin(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    target_agent_db_id: u64,
    is_admin: bool,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    require_admin_thread_participant(ctx, thread_id, actor.id)?;

    let target = get_thread_participant(ctx, thread_id, target_agent_db_id)
        .ok_or_else(|| "Target is not a participant of this thread".to_string())?;
    if !target.active {
        return Err("Target is not an active participant".to_string());
    }
    if target.is_admin == is_admin {
        return Ok(());
    }
    if target.is_admin && !is_admin {
        require_another_active_thread_admin(ctx, thread_id, target_agent_db_id)?;
    }

    let updated = ThreadParticipant {
        is_admin,
        updated_at: ctx.timestamp,
        active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
        ..target
    };
    ctx.db.thread_participant().id().update(updated);

    if !is_admin {
        promote_replacement_admin(ctx, thread_id);
    }
    bump_active_participants(ctx, thread_id);
    Ok(())
}
