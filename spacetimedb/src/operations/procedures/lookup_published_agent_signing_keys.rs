//! `lookup_published_agent_signing_keys` — anonymous-callable signing-key lookups for verifying
//! channel-message signatures. Returns the historical signing public key for each
//! `(agent_db_id, signing_key_version)` request, where the signing version is the coupled bundle
//! version.

use spacetimedb::ProcedureContext;

use crate::constants::{
    RateLimitAction, MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS, PUBLIC_KEY_LOOKUP_RATE_MAX_PER_WINDOW,
    PUBLIC_KEY_LOOKUP_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::operations::procedures::types::{
    PublishedAgentSigningKeyLookupRequest, PublishedAgentSigningKeyLookupRow,
};
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_published_agent_signing_keys(
    ctx: &mut ProcedureContext,
    requests: Vec<PublishedAgentSigningKeyLookupRequest>,
) -> Vec<PublishedAgentSigningKeyLookupRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let bk = bucket_key(
            RateLimitAction::PublicKeyLookup,
            sender,
            Some("published_signing_keys"),
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
            .take(MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS as usize)
            .filter_map(|request| {
                let bundle = tx
                    .db
                    .agent_key_bundle()
                    .agent_key_bundle_agent_db_id_key_bundle_version()
                    .filter((request.agent_db_id, request.signing_key_version))
                    .next()?;
                Some(PublishedAgentSigningKeyLookupRow {
                    agent_db_id: bundle.agent_db_id,
                    signing_key_version: bundle.key_bundle_version,
                    signing_public_key: bundle.signing_public_key,
                })
            })
            .collect()
    })
}
