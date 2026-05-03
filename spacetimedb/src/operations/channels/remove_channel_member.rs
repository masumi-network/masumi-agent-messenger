//! `remove_channel_member` — admin or self removes a channel member.

use spacetimedb::ReducerContext;

use crate::constants::ChannelPermission;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    channel_member_recency_sort_key, decrement_channel_account_membership, get_channel_member,
    require_active_channel_member, require_admin_channel_member, require_another_active_admin,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn remove_channel_member(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    target_agent_db_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    if actor.id == target_agent_db_id {
        require_active_channel_member(ctx, channel_id, actor.id)?;
    } else {
        require_admin_channel_member(ctx, channel_id, actor.id)?;
    }

    let target = get_channel_member(ctx, channel_id, target_agent_db_id)
        .ok_or_else(|| "Target is not a member of this channel".to_string())?;
    if !target.active {
        return Ok(());
    }
    if matches!(target.permission, ChannelPermission::Admin) {
        require_another_active_admin(ctx, channel_id, target_agent_db_id)?;
    }

    let target_account_id = target.account_id;
    let target_permission = target.permission;
    let updated = ChannelMember {
        active: false,
        active_recency_sort_key: channel_member_recency_sort_key(false, ctx.timestamp),
        updated_at: ctx.timestamp,
        ..target
    };
    ctx.db.channel_member().id().update(updated);
    decrement_channel_account_membership(ctx, channel_id, target_account_id, target_permission);
    Ok(())
}
