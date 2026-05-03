//! `upsert_masumi_registration` — set or clear the inline masumi registration on an agent row.
//!
//! Pass non-`None` values for registration network, inbox-agent id, and state to register; pass
//! `None` for all four fields to clear. `masumi_agent_identifier` is optional because pending
//! Masumi registrations can exist before the registry has assigned a public agent identifier.

use spacetimedb::ReducerContext;

use crate::constants::{
    MasumiRegistrationState, MAX_MASUMI_AGENT_IDENTIFIER_CHARS, MAX_MASUMI_NETWORK_CHARS,
    MAX_MASUMI_REGISTRATION_ID_CHARS,
};
use crate::helpers::account_signals::bump_owned_agents_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::validate::normalize_optional;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn upsert_masumi_registration(
    ctx: &ReducerContext,
    agent_db_id: u64,
    masumi_registration_network: Option<String>,
    masumi_inbox_agent_id: Option<String>,
    masumi_agent_identifier: Option<String>,
    masumi_registration_state: Option<MasumiRegistrationState>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let agent = ctx
        .db
        .agent()
        .id()
        .find(&agent_db_id)
        .ok_or_else(|| "Agent not found".to_string())?;
    if agent.account_id != account.id {
        return Err("Agent is owned by a different account".to_string());
    }

    let net = normalize_optional(
        masumi_registration_network.as_deref(),
        MAX_MASUMI_NETWORK_CHARS,
        "masumiRegistrationNetwork",
    )?;
    let inbox_agent = normalize_optional(
        masumi_inbox_agent_id.as_deref(),
        MAX_MASUMI_REGISTRATION_ID_CHARS,
        "masumiInboxAgentId",
    )?;
    let agent_identifier = normalize_optional(
        masumi_agent_identifier.as_deref(),
        MAX_MASUMI_AGENT_IDENTIFIER_CHARS,
        "masumiAgentIdentifier",
    )?;

    let (net, inbox_agent, agent_identifier, state) = match (
        net,
        inbox_agent,
        agent_identifier,
        masumi_registration_state,
    ) {
        (Some(net), Some(inbox), identifier, Some(state)) => {
            (Some(net), Some(inbox), identifier, Some(state))
        }
        (None, None, None, None) => (None, None, None, None),
        _ => {
            return Err(
                "masumiRegistrationNetwork, masumiInboxAgentId, and masumiRegistrationState must be Some together (register) or all masumi_* fields must be None together (clear)"
                    .to_string(),
            );
        }
    };

    ctx.db.agent().id().update(Agent {
        masumi_registration_network: net,
        masumi_inbox_agent_id: inbox_agent,
        masumi_agent_identifier: agent_identifier,
        masumi_registration_state: state,
        updated_at: ctx.timestamp,
        ..agent
    });
    bump_owned_agents_signal(ctx, account.id);

    Ok(())
}
