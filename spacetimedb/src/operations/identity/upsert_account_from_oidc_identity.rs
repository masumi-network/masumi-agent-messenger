//! `upsert_account_from_oidc_identity` — first-call onboarding.
//!
//! Creates `account` + default `agent` + initial `agent_key_bundle` + registers the calling
//! device. Idempotent — re-callable from a fresh device for an existing account; in that case
//! it skips agent/key creation and just upserts the device.
//!
//! Per the plan: the row no longer carries `auth_verified` or `email_attested` (always-true
//! after the OIDC verification gate above). The default agent's `inbox_identifier` column is
//! dropped (was redundant with `slug`).

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    DeviceEncryptionAlgorithm, EncryptionAlgorithm, SigningAlgorithm, MAX_DISPLAY_NAME_CHARS,
};
use crate::helpers::account_signals::bump_owned_agents_signal;
use crate::helpers::accounts::{
    build_default_slug_for_account, find_account_by_email, find_account_by_owner,
    get_default_agent, require_available_slug,
};
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::{upsert_device, DeviceUpsertParams};
use crate::helpers::oidc::{build_auth_identity_key, require_oidc_claims};
use crate::helpers::slug::{is_reserved_slug, normalize_slug};
use crate::helpers::validate::normalize_optional;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn upsert_account_from_oidc_identity(
    ctx: &ReducerContext,
    display_name: Option<String>,
    default_slug: Option<String>,
    encryption_public_key: String,
    key_bundle_version: u32,
    encryption_algorithm: EncryptionAlgorithm,
    signing_public_key: String,
    signing_algorithm: SigningAlgorithm,
    device_id: String,
    device_label: Option<String>,
    device_platform: Option<String>,
    device_encryption_public_key: String,
    device_encryption_key_version: u32,
    device_encryption_algorithm: DeviceEncryptionAlgorithm,
) -> Result<(), String> {
    let claims = require_oidc_claims(ctx)?;

    let normalized_display_name = normalize_optional(
        display_name.as_deref().or(claims.display_name.as_deref()),
        MAX_DISPLAY_NAME_CHARS,
        "displayName",
    )?;
    let normalized_default_slug = match default_slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => {
            let n = normalize_slug(s);
            if n.is_empty() {
                return Err("defaultSlug is required".to_string());
            }
            if is_reserved_slug(&n) {
                return Err("defaultSlug is reserved".to_string());
            }
            Some(n)
        }
        None => None,
    };
    let existing_by_email = find_account_by_email(ctx, &claims.email);
    let existing_by_owner = find_account_by_owner(ctx);

    if let Some(by_email) = &existing_by_email {
        if by_email.owner_identity != ctx.sender() {
            return Err("This email account is already owned by another identity".to_string());
        }
        if by_email.auth_issuer != claims.issuer || by_email.auth_subject != claims.subject {
            return Err(
                "This email account is already bound to a different OIDC identity".to_string(),
            );
        }
    }
    if let Some(by_owner) = &existing_by_owner {
        if by_owner.email != claims.email {
            return Err(
                "This OIDC identity is already bound to a different email namespace".to_string(),
            );
        }
        if by_owner.auth_issuer != claims.issuer || by_owner.auth_subject != claims.subject {
            return Err(
                "This Spacetime identity is already bound to a different OIDC identity".to_string(),
            );
        }
    }

    // Defense-in-depth: if both lookups returned a row, they must be the same row. Account
    // uniqueness on (owner_identity, email, auth_identity_key) makes a divergence here a logic
    // error — reject loudly so we never silently patch one row and orphan the other.
    if let (Some(by_email), Some(by_owner)) = (&existing_by_email, &existing_by_owner) {
        if by_email.id != by_owner.id {
            return Err(
                "Account state is inconsistent: email and owner-identity lookups resolved to different rows"
                    .to_string(),
            );
        }
    }

    let account = match existing_by_email.or(existing_by_owner) {
        Some(existing) => {
            let updated = Account {
                auth_subject: claims.subject.clone(),
                auth_issuer: claims.issuer.clone(),
                auth_identity_key: build_auth_identity_key(&claims.issuer, &claims.subject),
                auth_verified_at: ctx.timestamp,
                auth_expires_at: claims.expires_at,
                updated_at: ctx.timestamp,
                ..existing
            };
            ctx.db.account().id().update(updated)
        }
        None => ctx.db.account().insert(Account {
            id: 0,
            owner_identity: ctx.sender(),
            email: claims.email.clone(),
            auth_identity_key: build_auth_identity_key(&claims.issuer, &claims.subject),
            auth_subject: claims.subject.clone(),
            auth_issuer: claims.issuer.clone(),
            auth_verified_at: ctx.timestamp,
            auth_expires_at: claims.expires_at,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        }),
    };

    upsert_lease_for_account(ctx, &account, &claims)?;

    let default_agent = get_default_agent(ctx, account.id);
    if default_agent.is_none() {
        let normalized_encryption_key = crate::helpers::validate::normalize_required(
            &encryption_public_key,
            crate::constants::MAX_PUBLIC_KEY_CHARS,
            "encryptionPublicKey",
        )?;
        let normalized_signing_key = crate::helpers::validate::normalize_required(
            &signing_public_key,
            crate::constants::MAX_PUBLIC_KEY_CHARS,
            "signingPublicKey",
        )?;
        if key_bundle_version == 0 {
            return Err("keyBundleVersion must be > 0".to_string());
        }
        let slug = match normalized_default_slug {
            Some(s) => {
                require_available_slug(ctx, &s, None)?;
                s
            }
            None => build_default_slug_for_account(ctx, &claims.email)?,
        };
        let agent = ctx.db.agent().insert(Agent {
            id: 0,
            account_id: account.id,
            slug: slug.clone(),
            public_identity: slug,
            email: account.email.clone(),
            display_name: normalized_display_name.clone(),
            public_description: None,
            is_default: true,
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
    } else if let Some(existing) = default_agent {
        // Re-onboarding from a new device: keep the existing agent's keys (rotation must go
        // through `rotate_agent_keys`); only the display-name patch + the device upsert below
        // run on this path.
        let display_name_changed =
            normalized_display_name.is_some() && normalized_display_name != existing.display_name;
        if display_name_changed {
            let updated = Agent {
                display_name: normalized_display_name.clone(),
                updated_at: ctx.timestamp,
                ..existing
            };
            ctx.db.agent().id().update(updated);
            bump_owned_agents_signal(ctx, account.id);
        }
    }

    upsert_device(
        ctx,
        account.id,
        DeviceUpsertParams {
            device_id: &device_id,
            label: device_label.as_deref(),
            platform: device_platform.as_deref(),
            device_encryption_public_key: &device_encryption_public_key,
            device_encryption_key_version,
            device_encryption_algorithm,
            auto_approve: true,
        },
    )?;

    Ok(())
}
