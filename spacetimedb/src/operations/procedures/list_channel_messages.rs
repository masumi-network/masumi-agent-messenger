//! `list_channel_messages` — paginated messages in a channel for an active member. Cursor
//! `before_message_id?`. Auth-gated: caller must own an active `channel_member` row in the
//! channel.

use std::ops::Bound;

use spacetimedb::{ProcedureContext, TxContext};

use crate::constants::MAX_CHANNEL_MESSAGE_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

fn list_channel_message_window(
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
pub fn list_channel_messages(
    ctx: &mut ProcedureContext,
    channel_id: u64,
    before_message_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<ChannelMessage> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let is_member = tx
            .db
            .channel_member()
            .channel_member_channel_id_account_id_active()
            .filter((channel_id, account_id, true))
            .next()
            .is_some();
        if !is_member {
            return Vec::new();
        }
        if tx.db.channel().id().find(&channel_id).is_none() {
            return Vec::new();
        }

        let cap = limit
            .unwrap_or(MAX_CHANNEL_MESSAGE_PAGE_SIZE)
            .min(MAX_CHANNEL_MESSAGE_PAGE_SIZE) as usize;
        list_channel_message_window(tx, channel_id, before_message_id, cap)
    })
}
