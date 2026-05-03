//! `create_channel` — create a new channel and seat the creator as `Admin`.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ChannelAccessMode, ChannelPermission, RateLimitAction, CHANNEL_CREATE_RATE_MAX_PER_WINDOW,
    CHANNEL_CREATE_RATE_WINDOW_MS, MAX_CHANNEL_DESCRIPTION_CHARS, MAX_CHANNEL_SLUG_CHARS,
    MAX_CHANNEL_TITLE_CHARS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    ensure_channel_member, public_discoverable_channel_id_desc_sort_key,
    public_discoverable_channel_page_sort_key, public_discoverable_channel_sort_key,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::validate::{normalize_optional, normalize_slug_string};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn create_channel(
    ctx: &ReducerContext,
    agent_db_id: u64,
    slug: String,
    title: Option<String>,
    description: Option<String>,
    access_mode: ChannelAccessMode,
    discoverable: bool,
    default_permission: Option<ChannelPermission>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let resolved_default_permission = default_permission.unwrap_or(ChannelPermission::ReadWrite);
    if matches!(resolved_default_permission, ChannelPermission::Admin) {
        return Err("Channel default permission cannot be Admin".to_string());
    }

    let bk = bucket_key(RateLimitAction::ChannelCreate, ctx.sender(), None);
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ChannelCreate,
            owner_identity: ctx.sender(),
            window_ms: CHANNEL_CREATE_RATE_WINDOW_MS as i64,
            max_count: CHANNEL_CREATE_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Channel create rate limit exceeded; try again later".to_string());
    }

    let normalized_slug = normalize_slug_string(&slug, "channelSlug")?;
    if normalized_slug.chars().count() > MAX_CHANNEL_SLUG_CHARS {
        return Err(format!(
            "channelSlug must be {MAX_CHANNEL_SLUG_CHARS} characters or fewer"
        ));
    }
    if ctx
        .db
        .channel()
        .slug()
        .find(normalized_slug.clone())
        .is_some()
    {
        return Err("channelSlug is already in use".to_string());
    }
    let normalized_title = normalize_optional(title.as_deref(), MAX_CHANNEL_TITLE_CHARS, "title")?;
    let normalized_description = normalize_optional(
        description.as_deref(),
        MAX_CHANNEL_DESCRIPTION_CHARS,
        "description",
    )?;

    let inserted_channel = ctx.db.channel().insert(Channel {
        id: 0,
        slug: normalized_slug,
        title: normalized_title,
        description: normalized_description,
        access_mode,
        discoverable,
        public_discoverable_sort_key: public_discoverable_channel_sort_key(
            access_mode,
            discoverable,
            ctx.timestamp,
        ),
        public_discoverable_id_desc_sort_key: u64::MAX,
        public_discoverable_page_sort_key: u64::MAX.to_string(),
        default_permission: resolved_default_permission,
        creator_agent_db_id: actor.id,
        last_message_id: 0,
        message_count: 0,
        last_message_at: ctx.timestamp,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    let channel = ctx.db.channel().id().update(Channel {
        public_discoverable_id_desc_sort_key: public_discoverable_channel_id_desc_sort_key(
            access_mode,
            discoverable,
            inserted_channel.id,
        ),
        public_discoverable_page_sort_key: public_discoverable_channel_page_sort_key(
            access_mode,
            discoverable,
            ctx.timestamp,
            inserted_channel.id,
        ),
        ..inserted_channel
    });

    ensure_channel_member(ctx, channel.id, &actor, ChannelPermission::Admin)?;
    Ok(())
}
