//! `create_agent` — additional agent under an existing account.
//!
//! Was `createInboxIdentity` in the old schema; renamed because that name suggested account
//! creation (which is `upsert_account_from_oidc_identity`). One account can publish many agents
//! under different slugs, with independent key bundles and Masumi registrations.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    EncryptionAlgorithm, SigningAlgorithm, MAX_DISPLAY_NAME_CHARS, MAX_PUBLIC_KEY_CHARS,
};
use crate::helpers::account_signals::bump_owned_agents_signal;
use crate::helpers::accounts::{get_owned_account, require_available_slug};
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::validate::{
    normalize_custom_agent_slug, normalize_optional, normalize_required,
};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn create_agent(
    ctx: &ReducerContext,
    slug: String,
    display_name: Option<String>,
    encryption_public_key: String,
    key_bundle_version: u32,
    encryption_algorithm: EncryptionAlgorithm,
    signing_public_key: String,
    signing_algorithm: SigningAlgorithm,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let normalized_slug = normalize_custom_agent_slug(&slug, &account.email)?;
    require_available_slug(ctx, &normalized_slug, None)?;

    let normalized_display_name = normalize_optional(
        display_name.as_deref(),
        MAX_DISPLAY_NAME_CHARS,
        "displayName",
    )?;
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
    if key_bundle_version == 0 {
        return Err("keyBundleVersion must be > 0".to_string());
    }

    let agent = ctx.db.agent().insert(Agent {
        id: 0,
        account_id: account.id,
        slug: normalized_slug.clone(),
        public_identity: normalized_slug,
        email: account.email.clone(),
        display_name: normalized_display_name,
        public_description: None,
        is_default: false,
        public_linked_email_enabled: true,
        allow_all_message_content_types: true,
        allow_all_message_headers: true,
        supported_message_content_types: Vec::new(),
        supported_message_header_names: Vec::new(),
        masumi_registration_network: None,
        masumi_inbox_agent_id: None,
        masumi_agent_identifier: None,
        masumi_registration_state: None,
        current_key_bundle_version: key_bundle_version,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    ctx.db.agent_key_bundle().insert(AgentKeyBundle {
        id: 0,
        agent_db_id: agent.id,
        key_bundle_version,
        encryption_public_key: normalized_encryption_key,
        encryption_algorithm,
        signing_public_key: normalized_signing_key,
        signing_algorithm,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    bump_owned_agents_signal(ctx, account.id);

    Ok(())
}
