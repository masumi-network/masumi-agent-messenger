//! `accept_thread_invite` — invitee transitions a pending invite to accepted, joining the
//! thread. Fan-out reducer (membership change is visible to everyone).

use spacetimedb::ReducerContext;

use crate::constants::{ThreadInviteStatus, ThreadKind};
use crate::helpers::account_signals::bump_thread_invites_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::retention::{
    schedule_resolved_request_tombstone, ResolvedRequestTombstoneTarget,
};
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{
    ensure_thread_participant_reserved_at_version, get_thread_participant,
};
use crate::helpers::time::{descending_timestamp_key, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn accept_thread_invite(
    ctx: &ReducerContext,
    agent_db_id: u64,
    invite_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let invite = ctx
        .db
        .thread_invite()
        .id()
        .find(invite_id)
        .ok_or_else(|| "Thread invite not found".to_string())?;
    if invite.invitee_agent_db_id != actor.id {
        return Err("Caller is not the invitee on this invite".to_string());
    }
    if !matches!(invite.status, ThreadInviteStatus::Pending) {
        return Err("Thread invite is not pending".to_string());
    }

    let thread = ctx
        .db
        .thread()
        .id()
        .find(invite.thread_id)
        .ok_or_else(|| "Thread not found".to_string())?;
    if matches!(thread.kind, ThreadKind::Direct) {
        return Err("Cannot accept participant invites for a direct thread".to_string());
    }

    let was_already_active = get_thread_participant(ctx, thread.id, actor.id)
        .map(|participant| participant.active)
        .unwrap_or(false);

    if !was_already_active {
        let next_membership_version = thread.membership_version + 1;
        let bumped = Thread {
            membership_version: next_membership_version,
            updated_at: ctx.timestamp,
            ..thread.clone()
        };
        ctx.db.thread().id().update(bumped);
        ensure_thread_participant_reserved_at_version(
            ctx,
            &thread,
            &actor,
            false,
            1,
            next_membership_version,
        )?;
    } else {
        ensure_thread_participant_reserved_at_version(
            ctx,
            &thread,
            &actor,
            false,
            1,
            thread.membership_version,
        )?;
    }

    let resolved = ThreadInvite {
        status: ThreadInviteStatus::Accepted,
        resolved_at: Some(ctx.timestamp),
        resolved_by_agent_db_id: Some(actor.id),
        updated_at: ctx.timestamp,
        inviter_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        invitee_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        invitee_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        ..invite.clone()
    };
    ctx.db.thread_invite().id().update(resolved);
    bump_thread_invites_signal(ctx, invite.inviter_account_id);
    bump_thread_invites_signal(ctx, invite.invitee_account_id);
    schedule_resolved_request_tombstone(
        ctx,
        ResolvedRequestTombstoneTarget::ThreadInvite,
        invite.id,
    );

    bump_active_participants(ctx, invite.thread_id);
    Ok(())
}
