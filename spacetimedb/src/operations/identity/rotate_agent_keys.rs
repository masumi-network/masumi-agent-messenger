//! `rotate_agent_keys` — append new `agent_key_bundle` row, bump version pointer on `agent`.
//!
//! Massively slimmed from the TS version: no `unique_key`, no `sort_key='pending'` legacy, no
//! `current*PublicKey/Algorithm` columns to keep in sync on `agent` (the bundle is the source of
//! truth; agent only stores the bundle pointer). Bundle uniqueness is enforced via the 2-col
//! `(agent_db_id, key_bundle_version)` index; reducer rejects on collision.
//!
//! Per the rate limit plan: every rotation increments the `AgentKeyRotate` bucket.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    EncryptionAlgorithm, RateLimitAction, SigningAlgorithm, AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW,
    AGENT_KEY_ROTATE_RATE_WINDOW_MS, MAX_PUBLIC_KEY_CHARS,
};
use crate::helpers::account_signals::bump_owned_agents_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::retention::schedule_agent_key_bundle_archive;
use crate::helpers::validate::normalize_required;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn rotate_agent_keys(
    ctx: &ReducerContext,
    agent_db_id: u64,
    encryption_public_key: String,
    key_bundle_version: u32,
    encryption_algorithm: EncryptionAlgorithm,
    signing_public_key: String,
    signing_algorithm: SigningAlgorithm,
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

    let bk = bucket_key(
        RateLimitAction::AgentKeyRotate,
        ctx.sender(),
        Some(&agent_db_id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::AgentKeyRotate,
            owner_identity: ctx.sender(),
            window_ms: AGENT_KEY_ROTATE_RATE_WINDOW_MS as i64,
            max_count: AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Too many key rotations; try again later".to_string());
    }

    let normalized_encryption_key = normalize_required(
        &encryption_public_key,
        MAX_PUBLIC_KEY_CHARS,
        "encryptionPublicKey",
    )?;
    let normalized_signing_key = normalize_required(
        &signing_public_key,
        MAX_PUBLIC_KEY_CHARS,
        "signingPublicKey",
    )?;

    if key_bundle_version <= agent.current_key_bundle_version {
        return Err("keyBundleVersion must be greater than the current version".to_string());
    }

    let bundle_table = ctx.db.agent_key_bundle();
    if bundle_table
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((agent_db_id, key_bundle_version))
        .next()
        .is_some()
    {
        return Err("keyBundleVersion already registered for this agent".to_string());
    }

    bundle_table.insert(AgentKeyBundle {
        id: 0,
        agent_db_id,
        key_bundle_version,
        encryption_public_key: normalized_encryption_key,
        encryption_algorithm,
        signing_public_key: normalized_signing_key,
        signing_algorithm,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    let bumped = Agent {
        current_key_bundle_version: key_bundle_version,
        updated_at: ctx.timestamp,
        ..agent
    };
    ctx.db.agent().id().update(bumped);
    bump_owned_agents_signal(ctx, account.id);
    schedule_agent_key_bundle_archive(ctx, agent_db_id);

    Ok(())
}
