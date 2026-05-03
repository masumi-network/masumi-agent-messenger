//! `list_pending_thread_invites_page` — pending thread invites for the caller.

use std::ops::Bound;

use spacetimedb::ProcedureContext;

use crate::constants::{ThreadInviteStatus, MAX_VISIBLE_PENDING_THREAD_INVITE_ROWS};
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct PendingThreadInvitePage {
    pub thread_invites: Vec<ThreadInvite>,
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

fn thread_invite_sort_key(row: &ThreadInvite) -> String {
    format!("{}:{}", row.invitee_pending_sort_key, row.id)
}

fn empty_page() -> PendingThreadInvitePage {
    PendingThreadInvitePage {
        thread_invites: Vec::new(),
        next_after_sort_key: None,
    }
}

#[spacetimedb::procedure]
pub fn list_pending_thread_invites_page(
    ctx: &mut ProcedureContext,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> PendingThreadInvitePage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let cap = limit
            .unwrap_or(MAX_VISIBLE_PENDING_THREAD_INVITE_ROWS)
            .min(MAX_VISIBLE_PENDING_THREAD_INVITE_ROWS) as usize;
        if cap == 0 {
            return empty_page();
        }

        let target_len = cap.saturating_add(1);
        let mut thread_invites = Vec::with_capacity(target_len);
        if let Some((before_sort_key, maybe_before_id)) =
            after_sort_key.as_deref().and_then(parse_after_sort_key)
        {
            if let Some(before_id) = maybe_before_id {
                thread_invites.extend(
                    tx.db
                        .thread_invite()
                        .thread_invite_invitee_account_id_pending_sort_key_id()
                        .filter((
                            account_id,
                            before_sort_key,
                            (Bound::Excluded(before_id), Bound::Unbounded),
                        ))
                        .filter(|row| matches!(row.status, ThreadInviteStatus::Pending))
                        .take(target_len),
                );
            }
            if thread_invites.len() < target_len {
                thread_invites.extend(
                    tx.db
                        .thread_invite()
                        .thread_invite_invitee_account_id_pending_sort_key()
                        .filter((
                            account_id,
                            (
                                Bound::Excluded(before_sort_key),
                                Bound::Excluded(EXCLUDED_DESCENDING_TIMESTAMP_KEY),
                            ),
                        ))
                        .filter(|row| matches!(row.status, ThreadInviteStatus::Pending))
                        .take(target_len - thread_invites.len()),
                );
            }
        } else {
            thread_invites.extend(
                tx.db
                    .thread_invite()
                    .thread_invite_invitee_account_id_pending_sort_key()
                    .filter((account_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
                    .filter(|row| matches!(row.status, ThreadInviteStatus::Pending))
                    .take(target_len),
            );
        }

        thread_invites.sort_by(|a, b| {
            a.invitee_pending_sort_key
                .cmp(&b.invitee_pending_sort_key)
                .then_with(|| a.id.cmp(&b.id))
        });
        let has_more = thread_invites.len() > cap;
        thread_invites.truncate(cap);
        let next_after_sort_key = if has_more {
            thread_invites.last().map(thread_invite_sort_key)
        } else {
            None
        };

        PendingThreadInvitePage {
            thread_invites,
            next_after_sort_key,
        }
    })
}
