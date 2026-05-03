//! `update_channel_member_permission` — admin changes a member's permission. Renamed from
//! `setChannelMemberPermission` for naming symmetry. Cannot demote the last active admin.

use spacetimedb::ReducerContext;

use crate::constants::{
    ChannelPermission, RateLimitAction, CHANNEL_ADMIN_RATE_MAX_PER_WINDOW,
    CHANNEL_ADMIN_RATE_WINDOW_MS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    get_channel_member, require_admin_channel_member, require_another_active_admin,
    update_channel_account_admin_membership,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_channel_member_permission(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    target_agent_db_id: u64,
    permission: ChannelPermission,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;
    require_admin_channel_member(ctx, channel_id, actor.id)?;

    let bk = bucket_key(
        RateLimitAction::ChannelAdmin,
        ctx.sender(),
        Some(&channel_id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ChannelAdmin,
            owner_identity: ctx.sender(),
            window_ms: CHANNEL_ADMIN_RATE_WINDOW_MS as i64,
            max_count: CHANNEL_ADMIN_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Channel admin rate limit exceeded; try again later".to_string());
    }

    let target = get_channel_member(ctx, channel_id, target_agent_db_id)
        .ok_or_else(|| "Target is not a member of this channel".to_string())?;
    if target.permission == permission {
        return Ok(());
    }

    let old_permission = target.permission;
    let target_account_id = target.account_id;
    let target_active = target.active;
    if matches!(target.permission, ChannelPermission::Admin)
        && !matches!(permission, ChannelPermission::Admin)
    {
        require_another_active_admin(ctx, channel_id, target_agent_db_id)?;
    }

    let updated = ChannelMember {
        permission,
        updated_at: ctx.timestamp,
        ..target
    };
    ctx.db.channel_member().id().update(updated);
    if target_active {
        update_channel_account_admin_membership(
            ctx,
            channel_id,
            target_account_id,
            matches!(old_permission, ChannelPermission::Admin),
            matches!(permission, ChannelPermission::Admin),
        );
    }
    Ok(())
}
