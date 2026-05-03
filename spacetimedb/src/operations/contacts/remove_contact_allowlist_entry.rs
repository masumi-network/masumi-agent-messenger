//! `remove_contact_allowlist_entry` — owner deletes a previously-approved entry.

use spacetimedb::ReducerContext;

use crate::helpers::account_signals::bump_contact_allowlist_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn remove_contact_allowlist_entry(ctx: &ReducerContext, entry_id: u64) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let entry = ctx
        .db
        .contact_allowlist_entry()
        .id()
        .find(&entry_id)
        .ok_or_else(|| "Allowlist entry not found".to_string())?;
    if entry.account_id != account.id {
        return Err("Allowlist entry is owned by a different account".to_string());
    }

    ctx.db.contact_allowlist_entry().id().delete(&entry_id);
    bump_contact_allowlist_signal(ctx, account.id);
    Ok(())
}
