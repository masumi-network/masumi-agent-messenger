//! `list_thread_participants` — paginate active participants in a thread by insertion-order id.
//! Cursor: `after_id?`. Auth-gated: caller account must have an active participant.

use std::collections::BTreeSet;

use spacetimedb::ProcedureContext;

use crate::constants::MAX_THREAD_FANOUT;
use crate::operations::procedures::auth::caller_account_id;
use crate::operations::procedures::types::{
    thread_participant_preview, visible_agent_row_for_account, ThreadParticipantPreview,
    VisibleAgentRow,
};
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct ThreadParticipantPage {
    pub participants: Vec<ThreadParticipantPreview>,
    pub actors: Vec<VisibleAgentRow>,
    pub next_after_id: Option<u64>,
}

fn empty_page() -> ThreadParticipantPage {
    ThreadParticipantPage {
        participants: Vec::new(),
        actors: Vec::new(),
        next_after_id: None,
    }
}

#[spacetimedb::procedure]
pub fn list_thread_participants(
    ctx: &mut ProcedureContext,
    thread_id: u64,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> ThreadParticipantPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let is_participant = tx
            .db
            .thread_participant()
            .thread_participant_thread_id_account_id_active()
            .filter((thread_id, account_id, true))
            .next()
            .is_some();
        if !is_participant {
            return empty_page();
        }

        let cap = limit
            .map(|l| l as usize)
            .unwrap_or(MAX_THREAD_FANOUT)
            .min(MAX_THREAD_FANOUT);
        if cap == 0 {
            return empty_page();
        }
        let target_len = cap.saturating_add(1);
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        let mut participants: Vec<ThreadParticipant> = tx
            .db
            .thread_participant()
            .thread_participant_thread_id_active_id()
            .filter((thread_id, true, start_id..))
            .take(target_len)
            .collect();
        let has_more = participants.len() > cap;
        participants.truncate(cap);
        let next_after_id = if has_more {
            participants.last().map(|row| row.id)
        } else {
            None
        };

        let agent_ids: BTreeSet<u64> = participants.iter().map(|row| row.agent_db_id).collect();
        let actors = agent_ids
            .into_iter()
            .filter_map(|id| tx.db.agent().id().find(&id))
            .map(|agent| visible_agent_row_for_account(&agent, account_id))
            .collect();
        let participants = participants
            .iter()
            .map(|participant| {
                thread_participant_preview(participant, participant.account_id == account_id)
            })
            .collect();

        ThreadParticipantPage {
            participants,
            actors,
            next_after_id,
        }
    })
}
