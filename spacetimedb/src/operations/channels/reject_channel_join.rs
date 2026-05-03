//! `reject_channel_join` — admin transitions a pending request to rejected.

use spacetimedb::ReducerContext;

use crate::constants::ChannelJoinRequestStatus;
use crate::helpers::account_signals::bump_channel_join_requests_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    delete_channel_join_request_admin_visibility, require_admin_channel_member,
    sync_channel_join_request_resolved_admin_visibility_for_request,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::retention::{
    schedule_resolved_request_tombstone, ResolvedRequestTombstoneTarget,
};
use crate::helpers::time::{descending_timestamp_key, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn reject_channel_join(
    ctx: &ReducerContext,
    agent_db_id: u64,
    request_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let request = ctx
        .db
        .channel_join_request()
        .id()
        .find(&request_id)
        .ok_or_else(|| "Join request not found".to_string())?;
    require_admin_channel_member(ctx, request.channel_id, actor.id)?;

    if !matches!(request.status, ChannelJoinRequestStatus::Pending) {
        return Err("Join request is not pending".to_string());
    }

    let resolved = ChannelJoinRequest {
        status: ChannelJoinRequestStatus::Rejected,
        resolved_at: Some(ctx.timestamp),
        resolved_by_agent_db_id: Some(actor.id),
        updated_at: ctx.timestamp,
        channel_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        requester_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        channel_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        requester_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        ..request.clone()
    };
    ctx.db.channel_join_request().id().update(resolved.clone());
    bump_channel_join_requests_signal(ctx, request.requester_account_id);
    sync_channel_join_request_resolved_admin_visibility_for_request(ctx, &resolved);
    delete_channel_join_request_admin_visibility(ctx, request_id);
    schedule_resolved_request_tombstone(
        ctx,
        ResolvedRequestTombstoneTarget::ChannelJoinRequest,
        request.id,
    );
    Ok(())
}
