//! `lookup_agent_key_bundles` — return raw `agent_key_bundle` rows by
//! `(agent_db_id, key_bundle_version)`. Anonymous-callable; consumers use this when they need both
//! encryption and signing material for a specific rotation.
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
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct AgentKeyBundleLookupRequest {
    pub agent_db_id: u64,
    pub key_bundle_version: u32,
}

#[spacetimedb::procedure]
pub fn lookup_agent_key_bundles(
    ctx: &mut ProcedureContext,
    requests: Vec<AgentKeyBundleLookupRequest>,
) -> Vec<AgentKeyBundle> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    if requests.len() > MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS as usize {
        return Vec::new();
    }
    ctx.with_tx(|tx| {
        let bk = bucket_key(
            RateLimitAction::PublicKeyLookup,
            sender,
            Some("agent_key_bundles"),
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
            .filter_map(|request| {
                tx.db
                    .agent_key_bundle()
                    .agent_key_bundle_agent_db_id_key_bundle_version()
                    .filter((request.agent_db_id, request.key_bundle_version))
                    .next()
            })
            .collect()
    })
}
