//! `list_discoverable_channels` — authenticated discovery of public discoverable channels.
//! Cursor: `(before_last_message_at?, before_channel_id?)`. Returns the next page newest-first.

use std::ops::Bound;

use spacetimedb::{ProcedureContext, Timestamp};

use crate::constants::{ChannelAccessMode, MAX_VISIBLE_DISCOVERABLE_CHANNELS};
use crate::helpers::channels::{
    public_discoverable_channel_page_sort_key, public_discoverable_channel_sort_key,
    NON_DISCOVERABLE_CHANNEL_PAGE_SORT_KEY, NON_DISCOVERABLE_CHANNEL_SORT_KEY,
};
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn list_discoverable_channels(
    ctx: &mut ProcedureContext,
    before_last_message_at: Option<Timestamp>,
    before_channel_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<Channel> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        // Auth gate: discovery is for authenticated callers. Anonymous discovery was dropped.
        if caller_account_id(tx, sender, timestamp).is_none() {
            return Vec::new();
        }

        let cap = limit
            .unwrap_or(MAX_VISIBLE_DISCOVERABLE_CHANNELS)
            .min(MAX_VISIBLE_DISCOVERABLE_CHANNELS) as usize;
        if cap == 0 {
            return Vec::new();
        }

        let target_len = cap.saturating_add(1);
        let mut rows = Vec::with_capacity(target_len);

        if let Some(before) = before_last_message_at {
            if let Some(channel_id) = before_channel_id {
                let before_page_sort_key = public_discoverable_channel_page_sort_key(
                    ChannelAccessMode::Public,
                    true,
                    before,
                    channel_id,
                );
                rows.extend(
                    tx.db
                        .channel()
                        .channel_public_discoverable_page_sort_key()
                        .filter((
                            Bound::Excluded(before_page_sort_key.as_str()),
                            Bound::Excluded(NON_DISCOVERABLE_CHANNEL_PAGE_SORT_KEY),
                        ))
                        .take(target_len),
                );
            } else {
                let before_sort_key =
                    public_discoverable_channel_sort_key(ChannelAccessMode::Public, true, before);
                rows.extend(
                    tx.db
                        .channel()
                        .channel_public_discoverable_sort_key()
                        .filter((
                            Bound::Excluded(before_sort_key),
                            Bound::Excluded(NON_DISCOVERABLE_CHANNEL_SORT_KEY),
                        ))
                        .take(target_len),
                );
            }
        } else {
            rows.extend(
                tx.db
                    .channel()
                    .channel_public_discoverable_page_sort_key()
                    .filter((
                        Bound::<&str>::Unbounded,
                        Bound::Excluded(NON_DISCOVERABLE_CHANNEL_PAGE_SORT_KEY),
                    ))
                    .take(target_len),
            );
        }

        rows.sort_by(|a, b| {
            a.public_discoverable_page_sort_key
                .cmp(&b.public_discoverable_page_sort_key)
        });
        rows.truncate(cap);
        rows
    })
}
