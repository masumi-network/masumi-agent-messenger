//! `list_visible_channel_page` — caller's channels with a stable recency cursor.
//!
//! Returns account-level membership rows plus a cursor so clients can page without guessing from
//! timestamps. There is intentionally no vector-only legacy companion.

use std::collections::BTreeSet;
use std::ops::Bound;

use spacetimedb::ProcedureContext;

use crate::constants::MAX_VISIBLE_CHANNEL_PAGE_SIZE;
use crate::helpers::channels::INACTIVE_CHANNEL_MEMBER_SORT_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct VisibleChannelPage {
    pub channels: Vec<Channel>,
    pub account_memberships: Vec<ChannelAccountMembership>,
    pub next_after_sort_key: Option<String>,
}

fn parse_after_sort_key(value: &str) -> Option<(i64, Option<u64>)> {
    let mut parts = value.split(':');
    let sort_key = parts.next().and_then(|raw| raw.parse::<i64>().ok())?;
    if sort_key == i64::MIN || sort_key >= INACTIVE_CHANNEL_MEMBER_SORT_KEY {
        return None;
    }
    let row_id = parts.next().and_then(|raw| raw.parse::<u64>().ok());
    Some((sort_key, row_id))
}

fn channel_membership_sort_key(row: &ChannelAccountMembership) -> String {
    format!("{}:{}", row.active_recency_sort_key, row.id)
}

fn empty_page() -> VisibleChannelPage {
    VisibleChannelPage {
        channels: Vec::new(),
        account_memberships: Vec::new(),
        next_after_sort_key: None,
    }
}

#[spacetimedb::procedure]
pub fn list_visible_channel_page(
    ctx: &mut ProcedureContext,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> VisibleChannelPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };

        let cap = limit
            .unwrap_or(MAX_VISIBLE_CHANNEL_PAGE_SIZE)
            .min(MAX_VISIBLE_CHANNEL_PAGE_SIZE) as usize;
        if cap == 0 {
            return empty_page();
        }

        let target_len = cap.saturating_add(1);
        let mut rows = Vec::with_capacity(target_len);
        if let Some((before_sort_key, maybe_before_id)) =
            after_sort_key.as_deref().and_then(parse_after_sort_key)
        {
            if let Some(before_id) = maybe_before_id {
                rows.extend(
                    tx.db
                        .channel_account_membership()
                        .channel_account_membership_account_id_active_recency_sort_key_id()
                        .filter((
                            account_id,
                            before_sort_key,
                            (Bound::Excluded(before_id), Bound::Unbounded),
                        ))
                        .take(target_len),
                );
            }
            if rows.len() < target_len {
                rows.extend(
                    tx.db
                        .channel_account_membership()
                        .channel_account_membership_account_id_active_recency_sort_key()
                        .filter((
                            account_id,
                            (
                                Bound::Excluded(before_sort_key),
                                Bound::Excluded(INACTIVE_CHANNEL_MEMBER_SORT_KEY),
                            ),
                        ))
                        .take(target_len - rows.len()),
                );
            }
        } else {
            rows.extend(
                tx.db
                    .channel_account_membership()
                    .channel_account_membership_account_id_active_recency_sort_key()
                    .filter((account_id, ..INACTIVE_CHANNEL_MEMBER_SORT_KEY))
                    .take(target_len),
            );
        }

        rows.sort_by(|a, b| {
            a.active_recency_sort_key
                .cmp(&b.active_recency_sort_key)
                .then_with(|| a.id.cmp(&b.id))
        });
        rows.dedup_by_key(|row| row.channel_id);

        let has_more = rows.len() > cap;
        rows.truncate(cap);
        let next_after_sort_key = if has_more {
            rows.last().map(channel_membership_sort_key)
        } else {
            None
        };

        let mut seen_channels = BTreeSet::new();
        let channels = rows
            .iter()
            .filter(|row| seen_channels.insert(row.channel_id))
            .filter_map(|row| tx.db.channel().id().find(&row.channel_id))
            .collect();

        VisibleChannelPage {
            channels,
            account_memberships: rows,
            next_after_sort_key,
        }
    })
}
