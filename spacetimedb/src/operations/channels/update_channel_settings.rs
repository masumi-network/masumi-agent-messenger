//! `update_channel_settings` — admin patch for title/description/access mode/discoverable.

use spacetimedb::ReducerContext;

use crate::constants::{
    ChannelAccessMode, ChannelPermission, RateLimitAction, CHANNEL_ADMIN_RATE_MAX_PER_WINDOW,
    CHANNEL_ADMIN_RATE_WINDOW_MS, MAX_CHANNEL_DESCRIPTION_CHARS, MAX_CHANNEL_TITLE_CHARS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    public_discoverable_channel_id_desc_sort_key, public_discoverable_channel_page_sort_key,
    public_discoverable_channel_sort_key, require_admin_channel_member,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::validate::normalize_optional;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_channel_settings(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    title: Option<String>,
    description: Option<String>,
    access_mode: Option<ChannelAccessMode>,
    discoverable: Option<bool>,
    default_permission: Option<ChannelPermission>,
) -> Result<(), String> {
    if let Some(p) = default_permission {
        if matches!(p, ChannelPermission::Admin) {
            return Err("Channel default permission cannot be Admin".to_string());
        }
    }
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

    let channel = ctx
        .db
        .channel()
        .id()
        .find(&channel_id)
        .ok_or_else(|| "Channel not found".to_string())?;

    let normalized_title = match title {
        None => channel.title.clone(),
        Some(t) if t.trim().is_empty() => None,
        Some(t) => normalize_optional(Some(&t), MAX_CHANNEL_TITLE_CHARS, "title")?,
    };
    let normalized_description = match description {
        None => channel.description.clone(),
        Some(d) if d.trim().is_empty() => None,
        Some(d) => normalize_optional(Some(&d), MAX_CHANNEL_DESCRIPTION_CHARS, "description")?,
    };

    let next_access_mode = access_mode.unwrap_or(channel.access_mode);
    let next_discoverable = discoverable.unwrap_or(channel.discoverable);
    let next_default_permission = default_permission.unwrap_or(channel.default_permission);
    let updated = Channel {
        title: normalized_title,
        description: normalized_description,
        access_mode: next_access_mode,
        discoverable: next_discoverable,
        public_discoverable_sort_key: public_discoverable_channel_sort_key(
            next_access_mode,
            next_discoverable,
            channel.last_message_at,
        ),
        public_discoverable_id_desc_sort_key: public_discoverable_channel_id_desc_sort_key(
            next_access_mode,
            next_discoverable,
            channel.id,
        ),
        public_discoverable_page_sort_key: public_discoverable_channel_page_sort_key(
            next_access_mode,
            next_discoverable,
            channel.last_message_at,
            channel.id,
        ),
        default_permission: next_default_permission,
        updated_at: ctx.timestamp,
        ..channel
    };
    ctx.db.channel().id().update(updated);
    Ok(())
}
