//! `join_public_channel` — caller joins a `Public` channel directly at the channel's
//! `default_permission`. A joiner who wants a different permission, or an existing member who
//! wants to change permission, must use `request_channel_join` instead so an admin can approve.

use spacetimedb::ReducerContext;

use crate::constants::{
    ChannelAccessMode, RateLimitAction, CHANNEL_JOIN_RATE_MAX_PER_WINDOW,
    CHANNEL_JOIN_RATE_WINDOW_MS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{ensure_channel_member, get_channel_member};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn join_public_channel(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let bk = bucket_key(RateLimitAction::ChannelJoin, ctx.sender(), None);
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ChannelJoin,
            owner_identity: ctx.sender(),
            window_ms: CHANNEL_JOIN_RATE_WINDOW_MS as i64,
            max_count: CHANNEL_JOIN_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Channel join rate limit exceeded; try again later".to_string());
    }

    let channel = ctx
        .db
        .channel()
        .id()
        .find(&channel_id)
        .ok_or_else(|| "Channel not found".to_string())?;
    if !matches!(channel.access_mode, ChannelAccessMode::Public) {
        return Err("Channel is not open for direct joins; request approval instead".to_string());
    }
    if let Some(m) = get_channel_member(ctx, channel_id, actor.id) {
        if m.active {
            return Err(
                "Caller is already a member of this channel; use request_channel_join to change permission"
                    .to_string(),
            );
        }
    }

    ensure_channel_member(ctx, channel_id, &actor, channel.default_permission)?;
    Ok(())
}
