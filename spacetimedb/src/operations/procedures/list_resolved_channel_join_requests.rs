//! `list_resolved_channel_join_requests` — historical channel-join requests for caller.

use std::collections::BTreeMap;
use std::ops::Bound;

use spacetimedb::ProcedureContext;

use crate::constants::MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE;
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct ResolvedChannelJoinRequestPage {
    pub join_requests: Vec<ChannelJoinRequest>,
    pub next_after_sort_key: Option<String>,
}

fn parse_after_sort_key(value: &str) -> Option<(i64, Option<u64>)> {
    let mut parts = value.split(':');
    let sort_key = parts.next().and_then(|raw| raw.parse::<i64>().ok())?;
    if sort_key == i64::MIN || sort_key >= EXCLUDED_DESCENDING_TIMESTAMP_KEY {
        return None;
    }
    let row_id = parts.next().and_then(|raw| raw.parse::<u64>().ok());
    Some((sort_key, row_id))
}

fn row_cursor(sort_key: i64, row: &ChannelJoinRequest) -> String {
    format!("{}:{}", sort_key, row.id)
}

fn insert_join_request(
    rows: &mut BTreeMap<u64, (i64, ChannelJoinRequest)>,
    sort_key: i64,
    row: ChannelJoinRequest,
) {
    rows.entry(row.id)
        .and_modify(|existing| {
            if sort_key < existing.0 {
                *existing = (sort_key, row.clone());
            }
        })
        .or_insert((sort_key, row));
}

fn empty_page() -> ResolvedChannelJoinRequestPage {
    ResolvedChannelJoinRequestPage {
        join_requests: Vec::new(),
        next_after_sort_key: None,
    }
}

#[spacetimedb::procedure]
pub fn list_resolved_channel_join_requests(
    ctx: &mut ProcedureContext,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> ResolvedChannelJoinRequestPage {
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
        let mut by_id: BTreeMap<u64, (i64, ChannelJoinRequest)> = BTreeMap::new();

        if let Some((after_key, maybe_after_id)) = cursor {
            if let Some(after_id) = maybe_after_id {
                for row in tx
                    .db
                    .channel_join_request()
                    .channel_join_request_requester_account_id_resolved_sort_key_id()
                    .filter((
                        account_id,
                        after_key,
                        (Bound::Excluded(after_id), Bound::Unbounded),
                    ))
                    .take(target_len)
                {
                    insert_join_request(&mut by_id, row.requester_resolved_sort_key, row);
                }
                for visibility in tx
                    .db
                    .channel_join_request_resolved_admin_visibility()
                    .channel_join_request_resolved_admin_visibility_admin_account_id_resolved_sort_key_request_id()
                    .filter((
                        account_id,
                        after_key,
                        (Bound::Excluded(after_id), Bound::Unbounded),
                    ))
                    .take(target_len)
                {
                    if let Some(row) = tx
                        .db
                        .channel_join_request()
                        .id()
                        .find(&visibility.request_id)
                    {
                        insert_join_request(&mut by_id, visibility.resolved_sort_key, row);
                    }
                }
            }

            for row in tx
                .db
                .channel_join_request()
                .channel_join_request_requester_account_id_resolved_sort_key_id()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(after_key),
                        Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                    ),
                ))
                .take(target_len)
            {
                insert_join_request(&mut by_id, row.requester_resolved_sort_key, row);
            }
            for visibility in tx
                .db
                .channel_join_request_resolved_admin_visibility()
                .channel_join_request_resolved_admin_visibility_admin_account_id_resolved_sort_key_request_id()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(after_key),
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
                    insert_join_request(&mut by_id, visibility.resolved_sort_key, row);
                }
            }
        } else {
            for row in tx
                .db
                .channel_join_request()
                .channel_join_request_requester_account_id_resolved_sort_key_id()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .take(target_len)
            {
                insert_join_request(&mut by_id, row.requester_resolved_sort_key, row);
            }
            for visibility in tx
                .db
                .channel_join_request_resolved_admin_visibility()
                .channel_join_request_resolved_admin_visibility_admin_account_id_resolved_sort_key_request_id()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .take(target_len)
            {
                if let Some(row) = tx
                    .db
                    .channel_join_request()
                    .id()
                    .find(&visibility.request_id)
                {
                    insert_join_request(&mut by_id, visibility.resolved_sort_key, row);
                }
            }
        }

        let mut keyed_rows: Vec<(i64, ChannelJoinRequest)> = by_id.into_values().collect();
        keyed_rows
            .sort_by(|(a_key, a), (b_key, b)| a_key.cmp(b_key).then_with(|| a.id.cmp(&b.id)));
        let has_more = keyed_rows.len() > cap;
        keyed_rows.truncate(cap);
        let next_after_sort_key = if has_more {
            keyed_rows
                .last()
                .map(|(sort_key, row)| row_cursor(*sort_key, row))
        } else {
            None
        };
        let join_requests = keyed_rows.into_iter().map(|(_, row)| row).collect();

        ResolvedChannelJoinRequestPage {
            join_requests,
            next_after_sort_key,
        }
    })
}
