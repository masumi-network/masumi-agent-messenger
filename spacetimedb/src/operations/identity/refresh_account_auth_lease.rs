//! `refresh_account_auth_lease` — explicit lease refresh from a connected client.
//!
//! Used after the WS-token rotation so views (which read `lease.active`) keep returning rows.

use spacetimedb::ReducerContext;

use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::refresh_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;

#[spacetimedb::reducer]
pub fn refresh_account_auth_lease(ctx: &ReducerContext) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    refresh_lease_for_account(ctx, &account, &claims)?;
    Ok(())
}
