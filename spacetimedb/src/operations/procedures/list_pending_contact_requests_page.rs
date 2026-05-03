//! `list_pending_contact_requests_page` — pending contact requests visible to the caller.

use std::collections::BTreeMap;
use std::ops::Bound;

use spacetimedb::ProcedureContext;

use crate::constants::{ContactRequestStatus, MAX_VISIBLE_PENDING_CONTACT_REQUEST_ROWS};
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct PendingContactRequestPage {
    pub contact_requests: Vec<ContactRequest>,
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

fn contact_pending_sort_key(account_id: u64, row: &ContactRequest) -> i64 {
    if row.requester_account_id == account_id
        && row.requester_pending_sort_key != EXCLUDED_DESCENDING_TIMESTAMP_KEY
    {
        row.requester_pending_sort_key
    } else {
        row.target_pending_sort_key
    }
}

fn contact_request_sort_key(account_id: u64, row: &ContactRequest) -> String {
    format!("{}:{}", contact_pending_sort_key(account_id, row), row.id)
}

fn empty_page() -> PendingContactRequestPage {
    PendingContactRequestPage {
        contact_requests: Vec::new(),
        next_after_sort_key: None,
    }
}

#[spacetimedb::procedure]
pub fn list_pending_contact_requests_page(
    ctx: &mut ProcedureContext,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> PendingContactRequestPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let cap = limit
            .unwrap_or(MAX_VISIBLE_PENDING_CONTACT_REQUEST_ROWS)
            .min(MAX_VISIBLE_PENDING_CONTACT_REQUEST_ROWS) as usize;
        if cap == 0 {
            return empty_page();
        }

        let target_len = cap.saturating_add(1);
        let cursor = after_sort_key.as_deref().and_then(parse_after_sort_key);
        let mut by_id: BTreeMap<u64, ContactRequest> = BTreeMap::new();

        if let Some((before_sort_key, maybe_before_id)) = cursor {
            if let Some(before_id) = maybe_before_id {
                for row in tx
                    .db
                    .contact_request()
                    .contact_request_requester_account_id_pending_sort_key_id()
                    .filter((
                        account_id,
                        before_sort_key,
                        (Bound::Excluded(before_id), Bound::Unbounded),
                    ))
                    .filter(|row| {
                        matches!(row.status, ContactRequestStatus::Pending)
                            && row.requester_hidden_at.is_none()
                    })
                    .take(target_len)
                {
                    by_id.insert(row.id, row);
                }
                for row in tx
                    .db
                    .contact_request()
                    .contact_request_target_account_id_pending_sort_key_id()
                    .filter((
                        account_id,
                        before_sort_key,
                        (Bound::Excluded(before_id), Bound::Unbounded),
                    ))
                    .filter(|row| matches!(row.status, ContactRequestStatus::Pending))
                    .take(target_len)
                {
                    by_id.insert(row.id, row);
                }
            }
            for row in tx
                .db
                .contact_request()
                .contact_request_requester_account_id_pending_sort_key()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(before_sort_key),
                        Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                    ),
                ))
                .filter(|row| {
                    matches!(row.status, ContactRequestStatus::Pending)
                        && row.requester_hidden_at.is_none()
                })
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
            for row in tx
                .db
                .contact_request()
                .contact_request_target_account_id_pending_sort_key()
                .filter((
                    account_id,
                    (
                        Bound::Excluded(before_sort_key),
                        Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                    ),
                ))
                .filter(|row| matches!(row.status, ContactRequestStatus::Pending))
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
        } else {
            for row in tx
                .db
                .contact_request()
                .contact_request_requester_account_id_pending_sort_key()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .filter(|row| {
                    matches!(row.status, ContactRequestStatus::Pending)
                        && row.requester_hidden_at.is_none()
                })
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
            for row in tx
                .db
                .contact_request()
                .contact_request_target_account_id_pending_sort_key()
                .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                .filter(|row| matches!(row.status, ContactRequestStatus::Pending))
                .take(target_len)
            {
                by_id.insert(row.id, row);
            }
        }

        let mut contact_requests: Vec<ContactRequest> = by_id.into_values().collect();
        contact_requests.sort_by(|a, b| {
            contact_pending_sort_key(account_id, a)
                .cmp(&contact_pending_sort_key(account_id, b))
                .then_with(|| a.id.cmp(&b.id))
        });

        let has_more = contact_requests.len() > cap;
        contact_requests.truncate(cap);
        let next_after_sort_key = if has_more {
            contact_requests
                .last()
                .map(|row| contact_request_sort_key(account_id, row))
        } else {
            None
        };

        PendingContactRequestPage {
            contact_requests,
            next_after_sort_key,
        }
    })
}
