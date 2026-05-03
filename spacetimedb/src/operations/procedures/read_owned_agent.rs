//! `read_owned_agent` — caller's owned agent by slug. Returns `None` if the slug is not owned
//! by the caller.

use spacetimedb::ProcedureContext;

use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn read_owned_agent(ctx: &mut ProcedureContext, slug: String) -> Option<Agent> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let account_id = caller_account_id(tx, sender, timestamp)?;
        let agent = tx.db.agent().slug().find(&slug)?;
        if agent.account_id != account_id {
            return None;
        }
        Some(agent)
    })
}
