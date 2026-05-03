//! `list_owned_agents_page` — paginated owned-agent listing.
//! Cursor: `after_id?`.

use spacetimedb::ProcedureContext;

use crate::constants::MAX_AGENT_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct OwnedAgentPage {
    pub agents: Vec<Agent>,
    pub next_after_id: Option<u64>,
}

fn empty_page() -> OwnedAgentPage {
    OwnedAgentPage {
        agents: Vec::new(),
        next_after_id: None,
    }
}

#[spacetimedb::procedure]
pub fn list_owned_agents_page(
    ctx: &mut ProcedureContext,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> OwnedAgentPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let cap = limit
            .unwrap_or(MAX_AGENT_PAGE_SIZE)
            .min(MAX_AGENT_PAGE_SIZE) as usize;
        if cap == 0 {
            return empty_page();
        }
        let target_len = cap.saturating_add(1);
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        let mut agents: Vec<Agent> = tx
            .db
            .agent()
            .agent_account_id_id()
            .filter((account_id, start_id..))
            .take(target_len)
            .collect();
        let has_more = agents.len() > cap;
        agents.truncate(cap);
        let next_after_id = if has_more {
            agents.last().map(|row| row.id)
        } else {
            None
        };

        OwnedAgentPage {
            agents,
            next_after_id,
        }
    })
}
