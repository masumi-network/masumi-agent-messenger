//! `lookup_published_agent_by_slug` — anonymous slug → published agent profile.
//!
//! Resolves an agent identity from a visitor-supplied slug. Returns at most one row, but the
//! consumer expects a `Vec<...>` for shape consistency with the other lookup procedures.

use spacetimedb::ProcedureContext;

use crate::constants::{
    RateLimitAction, PUBLIC_AGENT_LOOKUP_RATE_MAX_PER_WINDOW, PUBLIC_AGENT_LOOKUP_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::helpers::validate::normalize_slug_string;
use crate::operations::procedures::types::PublishedAgentLookupRow;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn lookup_published_agent_by_slug(
    ctx: &mut ProcedureContext,
    slug: String,
) -> Vec<PublishedAgentLookupRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let bk = bucket_key(RateLimitAction::PublicAgentLookup, sender, None);
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::PublicAgentLookup,
                owner_identity: sender,
                window_ms: PUBLIC_AGENT_LOOKUP_RATE_WINDOW_MS as i64,
                max_count: PUBLIC_AGENT_LOOKUP_RATE_MAX_PER_WINDOW,
            },
        ) {
            return Vec::new();
        }
        let Ok(normalized_slug) = normalize_slug_string(&slug, "slug") else {
            return Vec::new();
        };
        let Some(agent) = tx.db.agent().slug().find(&normalized_slug) else {
            return Vec::new();
        };
        let Some(row) = build_published_agent_lookup_row(tx, &agent) else {
            return Vec::new();
        };
        vec![row]
    })
}

/// Pull the (encryption, signing) bundle that matches the agent's current key-bundle version and
/// flatten the agent + bundle into the enriched lookup row the consumers expect.
pub(crate) fn build_published_agent_lookup_row(
    tx: &spacetimedb::TxContext,
    agent: &Agent,
) -> Option<PublishedAgentLookupRow> {
    let bundle = tx
        .db
        .agent_key_bundle()
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((agent.id, agent.current_key_bundle_version))
        .next()?;
    let linked_email = if agent.public_linked_email_enabled {
        Some(agent.email.clone())
    } else {
        None
    };
    let agent_identifier = agent.masumi_agent_identifier.clone();
    Some(PublishedAgentLookupRow {
        agent_db_id: agent.id,
        slug: agent.slug.clone(),
        public_identity: agent.public_identity.clone(),
        display_name: agent.display_name.clone(),
        is_default: agent.is_default,
        linked_email,
        agent_identifier,
        encryption_key_version: agent.current_key_bundle_version,
        encryption_algorithm: encryption_algorithm_label(&bundle.encryption_algorithm),
        encryption_public_key: bundle.encryption_public_key,
        signing_key_version: agent.current_key_bundle_version,
        signing_algorithm: signing_algorithm_label(&bundle.signing_algorithm),
        signing_public_key: bundle.signing_public_key,
    })
}

pub(crate) fn encryption_algorithm_label(
    algorithm: &crate::constants::EncryptionAlgorithm,
) -> String {
    match algorithm {
        crate::constants::EncryptionAlgorithm::EcdhP256V1 => "ecdh-p256-v1".into(),
    }
}

pub(crate) fn signing_algorithm_label(algorithm: &crate::constants::SigningAlgorithm) -> String {
    match algorithm {
        crate::constants::SigningAlgorithm::EcdsaP256Sha256V1 => "ecdsa-p256-sha256-v1".into(),
    }
}
