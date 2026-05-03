//! `request_channel_join` — caller asks an admin to seat them on a channel at a specific
//! permission. Three flows go through this reducer:
//! - First-time joiner on an `ApprovalRequired` channel.
//! - First-time joiner on a `Public` channel who wants a permission **different** from
//!   `channel.default_permission` (matching default → use `join_public_channel`).
//! - Existing active member requesting a **different** permission (upgrade or downgrade).
//!
//! `Admin` is never granted via this path.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ChannelAccessMode, ChannelJoinRequestStatus, ChannelPermission, RateLimitAction,
    CHANNEL_JOIN_REQUEST_RATE_MAX_PER_WINDOW, CHANNEL_JOIN_REQUEST_RATE_WINDOW_MS,
};
use crate::helpers::account_signals::bump_channel_join_requests_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    get_channel_member, sync_channel_join_request_admin_visibility_for_request,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::time::{descending_timestamp_key, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn request_channel_join(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    requested_permission: ChannelPermission,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    if matches!(requested_permission, ChannelPermission::Admin) {
        return Err("Cannot request admin permission via join request".to_string());
    }

    let bk = bucket_key(RateLimitAction::ChannelJoinRequest, ctx.sender(), None);
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ChannelJoinRequest,
            owner_identity: ctx.sender(),
            window_ms: CHANNEL_JOIN_REQUEST_RATE_WINDOW_MS as i64,
            max_count: CHANNEL_JOIN_REQUEST_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Channel join request rate limit exceeded; try again later".to_string());
    }

    let channel = ctx
        .db
        .channel()
        .id()
        .find(&channel_id)
        .ok_or_else(|| "Channel not found".to_string())?;
    if let Some(m) = get_channel_member(ctx, channel_id, actor.id) {
        if m.active {
            if m.permission == requested_permission {
                return Err(
                    "Caller already has the requested permission on this channel".to_string(),
                );
            }
            if matches!(m.permission, ChannelPermission::Admin) {
                return Err(
                    "Admins cannot self-demote via a join request; ask another admin to update the permission directly"
                        .to_string(),
                );
            }
        }
    } else if matches!(channel.access_mode, ChannelAccessMode::Public)
        && requested_permission == channel.default_permission
    {
        return Err(
            "Channel is open at the requested permission; use join_public_channel instead"
                .to_string(),
        );
    }

    let existing_pending = ctx
        .db
        .channel_join_request()
        .channel_join_request_channel_id_requester_agent_db_id_status()
        .filter((channel_id, actor.id, ChannelJoinRequestStatus::Pending))
        .next();
    if existing_pending.is_some() {
        return Err("A pending join request already exists for this caller".to_string());
    }

    let request = ctx.db.channel_join_request().insert(ChannelJoinRequest {
        id: 0,
        channel_id,
        requester_agent_db_id: actor.id,
        requester_account_id: actor.account_id,
        permission: requested_permission,
        status: ChannelJoinRequestStatus::Pending,
        channel_resolved_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        requester_resolved_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        channel_pending_sort_key: descending_timestamp_key(ctx.timestamp),
        requester_pending_sort_key: descending_timestamp_key(ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        resolved_at: None,
        resolved_by_agent_db_id: None,
    });
    bump_channel_join_requests_signal(ctx, actor.account_id);
    sync_channel_join_request_admin_visibility_for_request(ctx, &request);
    Ok(())
}
