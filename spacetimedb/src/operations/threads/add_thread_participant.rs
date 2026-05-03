//! `add_thread_participant` — admin sends a thread invite to another agent.
//!
//! **Fan-out reducer** — bumps `updated_at` on all active participants after creating the
//! invite so the new pending invite surfaces at the top of everyone's recency list.
//!
//! **No silent auto-add.** Even when the admin and invitee already share direct-contact
//! permission, the invitee receives a `threadInvite` and must explicitly accept. Direct-
//! contact permission allows DM sends; it does NOT grant authority to pull a peer into a
//! group thread without their consent.

use spacetimedb::ReducerContext;

use crate::constants::ThreadKind;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::{get_owned_actor, get_required_agent_by_public_identity};
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{ensure_thread_invite, require_admin_thread_participant};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn add_thread_participant(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    invitee_public_identity: String,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    require_admin_thread_participant(ctx, thread_id, actor.id)?;

    let thread = ctx
        .db
        .thread()
        .id()
        .find(&thread_id)
        .ok_or_else(|| "Thread not found".to_string())?;
    if matches!(thread.kind, ThreadKind::Direct) {
        return Err("Cannot add participants to a direct thread".to_string());
    }
    let invitee = get_required_agent_by_public_identity(ctx, &invitee_public_identity)?;
    if invitee.id == actor.id {
        return Err("Cannot invite yourself".to_string());
    }

    ensure_thread_invite(ctx, thread_id, &actor, &invitee)?;

    bump_active_participants(ctx, thread_id);
    Ok(())
}
