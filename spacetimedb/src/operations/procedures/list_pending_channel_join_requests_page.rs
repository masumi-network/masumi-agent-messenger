//! `list_pending_channel_join_requests_page` — pending channel join requests for caller.
//!
//! Includes requester-side rows and moderator-side rows materialized in
//! `channel_join_request_admin_visibility`.

use std::collections::BTreeMap;
use std::ops::Bound;

use spacetimedb::ProcedureContext;

use crate::constants::{ChannelJoinRequestStatus, MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE};
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct PendingChannelJoinRequestPage {
    pub join_requests: Vec<ChannelJoinRequest>,
    pub next_after_sort_key: Option<String>,
}

fn parse_after_sort_key(value: &str) -> Option<(i64, Option<u64>)> {
    let mut parts = value.split(':');
    let sort_key = parts.next().and_then(|raw| raw.parse::<i64>().ok())?;
    // Reject boundary values that would produce ill-defined `Bound::Excluded` ranges or that
    // collide with `EXCLUDED_DESCENDING_TIMESTAMP_KEY` — neither shows up in live data.
    if sort_key == i64::MIN || sort_key >= EXCLUDED_DESCENDING_TIMESTAMP_KEY {
        return None;
    }
    let row_id = parts.next().and_then(|raw| raw.parse::<u64>().ok());
    Some((sort_key, row_id))
}

fn request_pending_sort_key(account_id: u64, row: &ChannelJoinRequest) -> i64 {
    if row.requester_account_id == account_id
        && row.requester_pending_sort_key != EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        row.requester_pending_sort_key
    } else {
        row.channel_pending_sort_key
    }
}

fn channel_join_request_sort_key(account_id: u64, row: &ChannelJoinRequest) -> String {
    format!("{}:{}", request_pending_sort_key(account_id, row), row.id)
}

fn empty_page() -> PendingChannelJoinRequestPage {
    PendingChannelJoinRequestPage {
        join_requests: Vec::new(),
        next_after_sort_key: None,
    }
}

#[spacetimedb::procedure]
pub fn list_pending_channel_join_requests_page(
    ctx: &mut ProcedureContext,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> PendingChannelJoinRequestPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let cap = limit
            .unwrap_or(MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE)
            .min(MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE) as usize;
        if cap == 0 {
            return empty_page();
        }

        let target_len = cap.saturating_add(1);
        let cursor = after_sort_key.as_deref().and_then(parse_after_sort_key);
        let mut by_id: BTreeMap<u64, ChannelJoinRequest> = BTreeMap::new();

        if let Some((before_sort_key, maybe_before_id)) = cursor {
            if let Some(before_id) = maybe_before_id {
                for row in tx
                    .db
                    .channel_join_request()
                    .channel_join_request_requester_account_id_pending_sort_key_id()
                    .filter((
                        account_id,
                        before_sort_key,
                        (Bound::Excluded(before_id), Bound::Unbounded),
                    ))
                    .filter(|row| matches!(row.status, ChannelJoinRequestStatus::Pending))
                    .take(target_len)
                {
                    by_id.insert(row.id, row);
                }
                for visibility in tx
                    .db
                    .channel_join_request_admin_visibility()
                    .channel_join_request_admin_visibility_admin_account_id_pending_sort_key_id()
                    .filter((
                        account_id,
                        before_sort_key,
                        (Bound::Excluded(before_id), Bound::Unbounded),
                    ))
                    .take(target_len)
                {
                    if let Some(row) = tx
                        .db
                        .channel_join_request()
                        .id()
                        .find(&visibility.request_id)
                    {
                        if matches!(row.status, ChannelJoinRequestStatus::Pending) {
                            by_id.insert(row.id, row);
                        }
                    }
                }
            }
            for row in tx
                .db
                .channel_join_request()
                .channel_join_request_requester_account_id_pending_sort_key()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(before_sort_key),
                        Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                    ),
                ))
                .filter(|row| matches!(row.status, ChannelJoinRequestStatus::Pending))
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
            for visibility in tx
                .db
                .channel_join_request_admin_visibility()
                .channel_join_request_admin_visibility_admin_account_id_pending_sort_key()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(before_sort_key),
                        Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                    ),
                ))
                .take(target_len)
            {
                if let Some(row) = tx
                    .db
                    .channel_join_request()
                    .id()
                    .find(&visibility.request_id)
                {
                    if matches!(row.status, ChannelJoinRequestStatus::Pending) {
                        by_id.insert(row.id, row);
                    }
                }
            }
        } else {
            for row in tx
                .db
                .channel_join_request()
                .channel_join_request_requester_account_id_pending_sort_key()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .filter(|row| matches!(row.status, ChannelJoinRequestStatus::Pending))
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
            for visibility in tx
                .db
                .channel_join_request_admin_visibility()
                .channel_join_request_admin_visibility_admin_account_id_pending_sort_key()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .take(target_len)
            {
                if let Some(row) = tx
                    .db
                    .channel_join_request()
                    .id()
                    .find(&visibility.request_id)
                {
                    if matches!(row.status, ChannelJoinRequestStatus::Pending) {
                        by_id.insert(row.id, row);
                    }
                }
            }
        }

        let mut join_requests: Vec<ChannelJoinRequest> = by_id.into_values().collect();
        join_requests.sort_by(|a, b| {
            request_pending_sort_key(account_id, a)
                .cmp(&request_pending_sort_key(account_id, b))
                .then_with(|| a.id.cmp(&b.id))
        });

        let has_more = join_requests.len() > cap;
        join_requests.truncate(cap);
        let next_after_sort_key = if has_more {
            join_requests
                .last()
                .map(|row| channel_join_request_sort_key(account_id, row))
        } else {
            None
        };

        PendingChannelJoinRequestPage {
            join_requests,
            next_after_sort_key,
        }
    })
}
