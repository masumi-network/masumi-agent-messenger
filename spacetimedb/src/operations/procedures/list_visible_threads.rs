//! `list_visible_threads` — selected actor's threads ordered by recency, paginated past the
//! bounded live window.
//!
//! Returns threads plus a tiny participant preview for list rendering. The selected actor's
//! participant/read-state row is included in that preview; full membership is loaded through
//! `list_thread_participants`.

use std::collections::BTreeSet;
use std::ops::Bound;

use spacetimedb::{ProcedureContext, TxContext};

use crate::constants::{MAX_VISIBLE_THREAD_PAGE_SIZE, MAX_VISIBLE_THREAD_PARTICIPANT_PREVIEW};
use crate::helpers::threads::INACTIVE_THREAD_PARTICIPANT_SORT_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::operations::procedures::types::{
    thread_participant_preview, visible_agent_row_for_account, ThreadParticipantPreview,
    VisibleAgentRow,
};
use crate::tables::*;

fn parse_after_sort_key(value: &str) -> Option<(i64, Option<u64>)> {
    let mut parts = value.split(':');
    let sort_key = parts.next().and_then(|raw| raw.parse::<i64>().ok())?;
    if sort_key == i64::MIN || sort_key >= INACTIVE_THREAD_PARTICIPANT_SORT_KEY {
        return None;
    }
    let row_id = parts.next().and_then(|raw| raw.parse::<u64>().ok());
    Some((sort_key, row_id))
}

fn thread_participant_sort_key(participant: &ThreadParticipant) -> String {
    format!("{}:{}", participant.active_recency_sort_key, participant.id)
}

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct VisibleThreadPage {
    pub threads: Vec<Thread>,
    pub participant_previews: Vec<ThreadParticipantPreview>,
    pub actors: Vec<VisibleAgentRow>,
    pub next_after_sort_key: Option<String>,
}

fn empty_page() -> VisibleThreadPage {
    VisibleThreadPage {
        threads: Vec::new(),
        participant_previews: Vec::new(),
        actors: Vec::new(),
        next_after_sort_key: None,
    }
}

pub fn build_visible_thread_page(
    tx: &TxContext,
    agent_db_id: u64,
    caller_account_id: u64,
    caller_participations: Vec<ThreadParticipant>,
    next_after_sort_key: Option<String>,
) -> VisibleThreadPage {
    let thread_ids: Vec<u64> = caller_participations.iter().map(|p| p.thread_id).collect();
    let threads: Vec<Thread> = thread_ids
        .iter()
        .filter_map(|id| tx.db.thread().id().find(id))
        .collect();

    let mut participant_previews: Vec<ThreadParticipantPreview> = Vec::new();
    let mut seen_participant_ids = BTreeSet::new();
    let mut agent_ids = BTreeSet::new();
    for caller_participant in &caller_participations {
        seen_participant_ids.insert(caller_participant.id);
        agent_ids.insert(caller_participant.agent_db_id);
        participant_previews.push(thread_participant_preview(caller_participant, true));

        let mut remaining = MAX_VISIBLE_THREAD_PARTICIPANT_PREVIEW.saturating_sub(1);
        if remaining == 0 {
            continue;
        }
        for participant in tx
            .db
            .thread_participant()
            .thread_participant_thread_id_active_id()
            .filter((caller_participant.thread_id, true, 0u64..))
        {
            if participant.agent_db_id == agent_db_id {
                continue;
            }
            if !seen_participant_ids.insert(participant.id) {
                continue;
            }
            agent_ids.insert(participant.agent_db_id);
            participant_previews.push(thread_participant_preview(&participant, false));
            remaining = remaining.saturating_sub(1);
            if remaining == 0 {
                break;
            }
        }
    }

    let actors: Vec<VisibleAgentRow> = agent_ids
        .into_iter()
        .filter_map(|id| tx.db.agent().id().find(&id))
        .map(|agent| visible_agent_row_for_account(&agent, caller_account_id))
        .collect();

    VisibleThreadPage {
        threads,
        participant_previews,
        actors,
        next_after_sort_key,
    }
}

#[spacetimedb::procedure]
pub fn list_visible_threads(
    ctx: &mut ProcedureContext,
    agent_db_id: u64,
    after_sort_key: Option<String>,
    limit: Option<u32>,
) -> VisibleThreadPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let Some(actor) = tx.db.agent().id().find(&agent_db_id) else {
            return empty_page();
        };
        if actor.account_id != account_id {
            return empty_page();
        }

        let cap = limit
            .unwrap_or(MAX_VISIBLE_THREAD_PAGE_SIZE)
            .min(MAX_VISIBLE_THREAD_PAGE_SIZE) as usize;
        if cap == 0 {
            return empty_page();
        }

        let target_len = cap.saturating_add(1);
        let mut caller_participations = Vec::with_capacity(target_len);
        if let Some((before_sort_key, maybe_before_id)) =
            after_sort_key.as_deref().and_then(parse_after_sort_key)
        {
            if let Some(before_id) = maybe_before_id {
                caller_participations.extend(
                    tx.db
                        .thread_participant()
                        .thread_participant_agent_db_id_active_recency_sort_key_id()
                        .filter((
                            agent_db_id,
                            before_sort_key,
                            (Bound::Excluded(before_id), Bound::Unbounded),
                        ))
                        .take(target_len),
                );
            }
            if caller_participations.len() < target_len {
                caller_participations.extend(
                    tx.db
                        .thread_participant()
                        .thread_participant_agent_db_id_active_recency_sort_key_id()
                        .filter((
                            agent_db_id,
                            (
                                Bound::Excluded(before_sort_key),
                                Bound::Excluded(INACTIVE_THREAD_PARTICIPANT_SORT_KEY),
                            ),
                        ))
                        .take(target_len - caller_participations.len()),
                );
            }
        } else {
            caller_participations.extend(
                tx.db
                    .thread_participant()
                    .thread_participant_agent_db_id_active_recency_sort_key_id()
                    .filter((agent_db_id, ..INACTIVE_THREAD_PARTICIPANT_SORT_KEY))
                    .take(target_len),
            );
        }

        caller_participations.sort_by(|a, b| {
            a.active_recency_sort_key
                .cmp(&b.active_recency_sort_key)
                .then_with(|| a.id.cmp(&b.id))
        });
        let has_more = caller_participations.len() > cap;
        caller_participations.truncate(cap);
        let next_after_sort_key = if has_more {
            caller_participations
                .last()
                .map(thread_participant_sort_key)
        } else {
            None
        };

        build_visible_thread_page(
            tx,
            agent_db_id,
            account_id,
            caller_participations,
            next_after_sort_key,
        )
    })
}
