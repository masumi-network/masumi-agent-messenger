//! `list_public_channel_messages` — anonymous-callable history reader for `Public` channels.
//!
//! Gates on `channel.access_mode = Public`. For non-public channels (or unknown channels),
//! returns an empty vec rather than leaking existence. Cursor: `before_message_id?`.
//!
//! Intentionally unrate-limited: identity-keyed buckets are useless for anonymous callers
//! (a fresh connection identity bypasses the bucket trivially) and the read is bounded by
//! `MAX_CHANNEL_MESSAGE_PAGE_SIZE`. Abuse mitigation belongs upstream (CDN / host-level).

use std::ops::Bound;

use spacetimedb::{ProcedureContext, TxContext};

use crate::constants::{ChannelAccessMode, MAX_CHANNEL_MESSAGE_PAGE_SIZE};
use crate::helpers::validate::normalize_slug_string;
use crate::tables::*;

fn list_public_channel_message_window(
    tx: &TxContext,
    channel_id: u64,
    before_message_id: Option<u64>,
    cap: usize,
) -> Vec<ChannelMessage> {
    if cap == 0 {
        return Vec::new();
    }

    if matches!(before_message_id, Some(0)) {
        return Vec::new();
    }

    let target_len = cap.saturating_add(1);
    let cursor = before_message_id.map(|id| u64::MAX.saturating_sub(id));
    let mut messages: Vec<ChannelMessage> = if let Some(cursor) = cursor {
        tx.db
            .channel_message()
            .channel_message_channel_id_id_desc_sort_key()
            .filter((channel_id, (Bound::Excluded(cursor), Bound::Unbounded)))
            .take(target_len)
            .collect()
    } else {
        tx.db
            .channel_message()
            .channel_message_channel_id_id_desc_sort_key()
            .filter((channel_id, 0u64..u64::MAX))
            .take(target_len)
            .collect()
    };
    messages.truncate(cap);
    messages
}

#[spacetimedb::procedure]
pub fn list_public_channel_messages(
    ctx: &mut ProcedureContext,
    channel_slug: String,
    before_message_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<ChannelMessage> {
    ctx.with_tx(|tx| {
        let Ok(slug) = normalize_slug_string(&channel_slug, "channelSlug") else {
            return Vec::new();
        };
        let Some(channel) = tx.db.channel().slug().find(&slug) else {
            return Vec::new();
        };
        if !matches!(channel.access_mode, ChannelAccessMode::Public) {
            return Vec::new();
        }
        let cap = limit
            .unwrap_or(MAX_CHANNEL_MESSAGE_PAGE_SIZE)
            .min(MAX_CHANNEL_MESSAGE_PAGE_SIZE) as usize;
        list_public_channel_message_window(tx, channel.id, before_message_id, cap)
    })
}
