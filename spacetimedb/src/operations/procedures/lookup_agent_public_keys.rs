//! `lookup_agent_public_keys` — given a list of `(agent_db_id, key_kind, key_version)`, return
//! the historical public-key bytes for each. Anonymous-callable; required for verifying
//! signatures on messages that reference older key versions than the caller's live window.
//!
//! Callers must keep `requests.len() <= MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS`. Oversized batches
//! return an empty Vec rather than a silently-truncated subset so callers don't act on partial
//! results.

use spacetimedb::ProcedureContext;

use crate::constants::{
    RateLimitAction, MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS, PUBLIC_KEY_LOOKUP_RATE_MAX_PER_WINDOW,
    PUBLIC_KEY_LOOKUP_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::operations::procedures::lookup_published_agent_by_slug::{
    encryption_algorithm_label, signing_algorithm_label,
};
use crate::operations::procedures::types::{
    AgentPublicKeyKind, AgentPublicKeyLookupRequest, AgentPublicKeyLookupRow,
};
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_agent_public_keys(
    ctx: &mut ProcedureContext,
    requests: Vec<AgentPublicKeyLookupRequest>,
) -> Vec<AgentPublicKeyLookupRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    if requests.len() > MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS as usize {
        return Vec::new();
    }
    ctx.with_tx(|tx| {
        let bk = bucket_key(
            RateLimitAction::PublicKeyLookup,
            sender,
            Some("agent_public_keys"),
        );
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::PublicKeyLookup,
                owner_identity: sender,
                window_ms: PUBLIC_KEY_LOOKUP_RATE_WINDOW_MS as i64,
                max_count: PUBLIC_KEY_LOOKUP_RATE_MAX_PER_WINDOW,
            },
        ) {
            return Vec::new();
        }
        requests
            .iter()
            .filter_map(|request| match request.key_kind {
                AgentPublicKeyKind::Encryption => {
                    let bundle = tx
                        .db
                        .agent_key_bundle()
                        .agent_key_bundle_agent_db_id_key_bundle_version()
                        .filter((request.agent_db_id, request.key_version))
                        .next()?;
                    Some(AgentPublicKeyLookupRow {
                        agent_db_id: bundle.agent_db_id,
                        key_kind: AgentPublicKeyKind::Encryption,
                        key_version: bundle.key_bundle_version,
                        public_key: bundle.encryption_public_key,
                        algorithm: encryption_algorithm_label(&bundle.encryption_algorithm),
                        created_at: bundle.created_at,
                    })
                }
                AgentPublicKeyKind::Signing => {
                    let bundle = tx
                        .db
                        .agent_key_bundle()
                        .agent_key_bundle_agent_db_id_key_bundle_version()
                        .filter((request.agent_db_id, request.key_version))
                        .next()?;
                    Some(AgentPublicKeyLookupRow {
                        agent_db_id: bundle.agent_db_id,
                        key_kind: AgentPublicKeyKind::Signing,
                        key_version: bundle.key_bundle_version,
                        public_key: bundle.signing_public_key,
                        algorithm: signing_algorithm_label(&bundle.signing_algorithm),
                        created_at: bundle.created_at,
                    })
                }
            })
            .collect()
    })
}
