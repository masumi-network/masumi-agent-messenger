//! `read_visible_thread` — fetch one visible thread with bounded participant preview.

use spacetimedb::ProcedureContext;

use crate::operations::procedures::auth::caller_account_id;
use crate::operations::procedures::list_visible_threads::{
    build_visible_thread_page, VisibleThreadPage,
};
use crate::tables::*;

#[spacetimedb::procedure]
pub fn read_visible_thread(
    ctx: &mut ProcedureContext,
    agent_db_id: u64,
    thread_id: u64,
) -> Option<VisibleThreadPage> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let account_id = caller_account_id(tx, sender, timestamp)?;
        let actor = tx.db.agent().id().find(&agent_db_id)?;
        if actor.account_id != account_id {
            return None;
        }
        let caller_participant = tx
            .db
            .thread_participant()
            .thread_participant_thread_id_agent_db_id()
            .filter((thread_id, agent_db_id))
            .next()?;
        if !caller_participant.active {
            return None;
        }
        tx.db.thread().id().find(&thread_id)?;
        Some(build_visible_thread_page(
            tx,
            agent_db_id,
            account_id,
            vec![caller_participant],
            None,
        ))
    })
}
