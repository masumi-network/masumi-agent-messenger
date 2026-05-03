//! `update_agent_profile` — single patch reducer for all profile fields.
//!
//! Replaces 3 setters from the old schema:
//! - `setAgentPublicLinkedEmailVisibility`
//! - `setAgentPublicDescription`
//! - `setAgentPublicMessageCapabilities`
//!
//! All optional patch fields; `None` means "leave unchanged". The capability fields are NOT
//! optional in the row schema (default `true` / `[]`) but the reducer parameter is
//! `Option<...>` to distinguish "patch this" from "leave alone".

use spacetimedb::ReducerContext;

use crate::constants::{
    MAX_AGENT_SUPPORTED_ENTRY_CHARS, MAX_AGENT_SUPPORTED_LIST_LEN, MAX_DISPLAY_NAME_CHARS,
    MAX_PUBLIC_DESCRIPTION_CHARS,
};
use crate::helpers::account_signals::bump_owned_agents_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::validate::{normalize_optional, validate_string_list};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_agent_profile(
    ctx: &ReducerContext,
    agent_db_id: u64,
    display_name: Option<String>,
    public_description: Option<String>,
    public_linked_email_enabled: Option<bool>,
    allow_all_message_content_types: Option<bool>,
    allow_all_message_headers: Option<bool>,
    supported_message_content_types: Option<Vec<String>>,
    supported_message_header_names: Option<Vec<String>>,
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

    let normalized_display_name = match display_name {
        None => agent.display_name.clone(),
        Some(d) if d.trim().is_empty() => None,
        Some(d) => normalize_optional(Some(&d), MAX_DISPLAY_NAME_CHARS, "displayName")?,
    };
    let normalized_description = match public_description {
        None => agent.public_description.clone(),
        Some(d) if d.trim().is_empty() => None,
        Some(d) => normalize_optional(Some(&d), MAX_PUBLIC_DESCRIPTION_CHARS, "publicDescription")?,
    };
    let normalized_supported_content_types = match supported_message_content_types {
        None => agent.supported_message_content_types.clone(),
        Some(values) => validate_string_list(
            values,
            MAX_AGENT_SUPPORTED_LIST_LEN,
            MAX_AGENT_SUPPORTED_ENTRY_CHARS,
            "supportedMessageContentTypes",
        )?,
    };
    let normalized_supported_header_names = match supported_message_header_names {
        None => agent.supported_message_header_names.clone(),
        Some(values) => validate_string_list(
            values,
            MAX_AGENT_SUPPORTED_LIST_LEN,
            MAX_AGENT_SUPPORTED_ENTRY_CHARS,
            "supportedMessageHeaderNames",
        )?,
    };

    let updated = Agent {
        display_name: normalized_display_name,
        public_description: normalized_description,
        public_linked_email_enabled: public_linked_email_enabled
            .unwrap_or(agent.public_linked_email_enabled),
        allow_all_message_content_types: allow_all_message_content_types
            .unwrap_or(agent.allow_all_message_content_types),
        allow_all_message_headers: allow_all_message_headers
            .unwrap_or(agent.allow_all_message_headers),
        supported_message_content_types: normalized_supported_content_types,
        supported_message_header_names: normalized_supported_header_names,
        updated_at: ctx.timestamp,
        ..agent
    };
    ctx.db.agent().id().update(updated);
    bump_owned_agents_signal(ctx, account.id);

    Ok(())
}
