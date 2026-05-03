//! `lookup_public_channel_by_slug` — anonymous direct-slug channel metadata lookup.
//!
//! This is not anonymous discovery: callers must already know the slug, and the procedure only
//! returns a row when the channel is open (`access_mode = Public`).

use spacetimedb::ProcedureContext;

use crate::constants::{
    ChannelAccessMode, RateLimitAction, PUBLIC_CHANNEL_LOOKUP_RATE_MAX_PER_WINDOW,
    PUBLIC_CHANNEL_LOOKUP_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::helpers::validate::normalize_slug_string;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_public_channel_by_slug(ctx: &mut ProcedureContext, slug: String) -> Option<Channel> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let bk = bucket_key(RateLimitAction::PublicChannelLookup, sender, None);
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::PublicChannelLookup,
                owner_identity: sender,
                window_ms: PUBLIC_CHANNEL_LOOKUP_RATE_WINDOW_MS as i64,
                max_count: PUBLIC_CHANNEL_LOOKUP_RATE_MAX_PER_WINDOW,
            },
        ) {
            return None;
        }
        let normalized_slug = normalize_slug_string(&slug, "channelSlug").ok()?;
        let channel = tx.db.channel().slug().find(&normalized_slug)?;
        if !matches!(channel.access_mode, ChannelAccessMode::Public) {
            return None;
        }
        Some(channel)
    })
}
