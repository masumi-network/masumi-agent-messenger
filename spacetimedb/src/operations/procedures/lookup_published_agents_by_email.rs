//! `lookup_published_agents_by_email_page` — paginated anonymous email lookup.
//!
//! Returns public-safe rows only when the agent explicitly exposes its linked email. Email is
//! denormalized onto agent rows (see `agent.email`) and paged by `(email, exposed, id)`.

use spacetimedb::ProcedureContext;

use crate::constants::{
    RateLimitAction, EMAIL_LOOKUP_RATE_MAX_PER_WINDOW, EMAIL_LOOKUP_RATE_WINDOW_MS,
    MAX_PUBLIC_AGENT_EMAIL_LOOKUP_PAGE_SIZE,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::helpers::validate::require_valid_email;
use crate::operations::procedures::lookup_published_agent_by_slug::build_published_agent_lookup_row;
use crate::operations::procedures::types::PublishedAgentLookupRow;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_published_agents_by_email_page(
    ctx: &mut ProcedureContext,
    email: String,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<PublishedAgentLookupRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let bk = bucket_key(RateLimitAction::EmailLookup, sender, None);
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::EmailLookup,
                owner_identity: sender,
                window_ms: EMAIL_LOOKUP_RATE_WINDOW_MS as i64,
                max_count: EMAIL_LOOKUP_RATE_MAX_PER_WINDOW,
            },
        ) {
            return Vec::new();
        }
        let Ok(normalized_email) = require_valid_email(&email, "email") else {
            return Vec::new();
        };
        let cap = limit
            .unwrap_or(MAX_PUBLIC_AGENT_EMAIL_LOOKUP_PAGE_SIZE)
            .min(MAX_PUBLIC_AGENT_EMAIL_LOOKUP_PAGE_SIZE) as usize;
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        tx.db
            .agent()
            .agent_email_public_linked_enabled_id()
            .filter((&normalized_email[..], true, start_id..))
            .take(cap)
            .filter_map(|agent| build_published_agent_lookup_row(tx, &agent))
            .collect()
    })
}
