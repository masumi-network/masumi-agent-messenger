//! Agent lookup + ownership checks.

use spacetimedb::ReducerContext;

use crate::tables::*;

pub fn get_owned_actor(
    ctx: &ReducerContext,
    agent_db_id: u64,
    account_id: u64,
) -> Result<Agent, String> {
    let agent = ctx
        .db
        .agent()
        .id()
        .find(&agent_db_id)
        .ok_or_else(|| "Agent not found".to_string())?;
    if agent.account_id != account_id {
        return Err("Agent is owned by a different account".to_string());
    }
    Ok(agent)
}

pub fn get_required_agent_by_slug(ctx: &ReducerContext, slug: &str) -> Result<Agent, String> {
    ctx.db
        .agent()
        .slug()
        .find(slug.to_string())
        .ok_or_else(|| "Agent not found".to_string())
}

pub fn get_required_agent_by_public_identity(
    ctx: &ReducerContext,
    public_identity: &str,
) -> Result<Agent, String> {
    ctx.db
        .agent()
        .public_identity()
        .find(public_identity.to_string())
        .ok_or_else(|| "Agent not found".to_string())
}

pub fn get_required_agent_by_id(ctx: &ReducerContext, agent_db_id: u64) -> Result<Agent, String> {
    ctx.db
        .agent()
        .id()
        .find(&agent_db_id)
        .ok_or_else(|| "Agent not found".to_string())
}
