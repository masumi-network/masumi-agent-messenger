//! `add_contact_allowlist_entry` — the account owner pre-approves a peer (agent slug or email).

use spacetimedb::{ReducerContext, Table};

use crate::constants::ContactAllowlistKind;
use crate::helpers::account_signals::bump_contact_allowlist_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::validate::{normalize_optional, require_valid_email};
use crate::tables::*;

const MAX_PUBLIC_IDENTITY_CHARS: usize = 256;

#[spacetimedb::reducer]
pub fn add_contact_allowlist_entry(
    ctx: &ReducerContext,
    agent_db_id: u64,
    kind: ContactAllowlistKind,
    agent_public_identity: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let agent_public_identity = match kind {
        ContactAllowlistKind::Agent => normalize_optional(
            agent_public_identity.as_deref(),
            MAX_PUBLIC_IDENTITY_CHARS,
            "agentPublicIdentity",
        )?,
        ContactAllowlistKind::Email => None,
    };
    let agent_slug = agent_public_identity.clone();
    let email = match kind {
        ContactAllowlistKind::Email => match email {
            Some(e) => Some(require_valid_email(&e, "normalizedEmail")?),
            None => {
                return Err("normalizedEmail is required for Email allowlist entries".to_string())
            }
        },
        ContactAllowlistKind::Agent => None,
    };
    if matches!(kind, ContactAllowlistKind::Agent) && agent_public_identity.is_none() {
        return Err("agentPublicIdentity is required for Agent allowlist entries".to_string());
    }
    let lookup_key = match kind {
        ContactAllowlistKind::Agent => agent_public_identity.clone().ok_or_else(|| {
            "agentPublicIdentity is required for Agent allowlist entries".to_string()
        })?,
        ContactAllowlistKind::Email => email
            .clone()
            .ok_or_else(|| "normalizedEmail is required for Email allowlist entries".to_string())?,
    };

    let dup = ctx
        .db
        .contact_allowlist_entry()
        .contact_allowlist_entry_account_id_kind_lookup_key()
        .filter((account.id, kind, &lookup_key[..]))
        .next()
        .is_some();
    if dup {
        return Err("Allowlist entry already exists".to_string());
    }

    ctx.db
        .contact_allowlist_entry()
        .insert(ContactAllowlistEntry {
            id: 0,
            account_id: account.id,
            kind,
            lookup_key,
            agent_public_identity,
            agent_slug,
            email,
            created_by_agent_db_id: actor.id,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    bump_contact_allowlist_signal(ctx, account.id);
    Ok(())
}
