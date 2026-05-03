//! `client_connected` — refresh the auth lease for the connecting account, if any.
//!
//! Lifecycle hook (not a client-callable reducer). If the caller has an account, refresh the
//! lease; if the OIDC token is invalid (expired, wrong issuer/audience, missing claims),
//! deactivate the lease so views correctly report unauthenticated.

use spacetimedb::ReducerContext;

use crate::helpers::accounts::find_account_by_owner;
use crate::helpers::auth_lease::{deactivate_sender_lease, upsert_lease_for_account};
use crate::helpers::oidc::require_oidc_claims;

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) -> Result<(), String> {
    let Some(account) = find_account_by_owner(ctx) else {
        return Ok(());
    };
    match require_oidc_claims(ctx) {
        Ok(claims) => {
            upsert_lease_for_account(ctx, &account, &claims)?;
        }
        Err(_) => {
            deactivate_sender_lease(ctx);
        }
    }
    Ok(())
}
