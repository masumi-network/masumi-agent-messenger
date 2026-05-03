//! `account_auth_lease` lifecycle.
//!
//! Client-callable reducers invoke `upsert_lease_for_account` to keep an authenticated caller's
//! view lease alive. To avoid write amplification on hot reducer paths, existing active leases
//! are refreshed only when they are near expiry. Views read the lease (`lease.active`) without
//! wall-clock; the `expire_scheduled` dispatcher flips `active=false` at `expires_at`.
//!
//! Slimmed from the TS version: the lease row no longer carries `auth_identity_key`,
//! `email`, `auth_issuer`, `auth_subject` (all derivable from the `account` row).

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ScheduledExpiryKind, ACCOUNT_AUTH_LEASE_DURATION_MS, ACCOUNT_AUTH_LEASE_REFRESH_THRESHOLD_MS,
};
use crate::helpers::account_signals::ensure_account_change_signal;
use crate::helpers::oidc::{require_future_oidc_expiry, OidcClaims};
use crate::helpers::scheduling::{cancel_expiry_for, schedule_expiry};
use crate::helpers::time::timestamp_plus_ms;
use crate::tables::*;

pub fn upsert_lease_for_account(
    ctx: &ReducerContext,
    account: &Account,
    claims: &OidcClaims,
) -> Result<AccountAuthLease, String> {
    upsert_lease_for_account_inner(ctx, account, claims, false)
}

/// Force-refresh the lease for `account` keyed on `ctx.sender`. Used by the explicit refresh
/// reducer after connect/token rotation.
pub fn refresh_lease_for_account(
    ctx: &ReducerContext,
    account: &Account,
    claims: &OidcClaims,
) -> Result<AccountAuthLease, String> {
    upsert_lease_for_account_inner(ctx, account, claims, true)
}

/// Upsert the lease for `account` keyed on `ctx.sender`. Reschedules the matching expiry row
/// only when a write is needed. Caller is responsible for verifying `account` matches the OIDC
/// claim set.
fn upsert_lease_for_account_inner(
    ctx: &ReducerContext,
    account: &Account,
    claims: &OidcClaims,
    force_refresh: bool,
) -> Result<AccountAuthLease, String> {
    if account.auth_issuer != claims.issuer || account.auth_subject != claims.subject {
        return Err("Current OIDC session is not authorized for this account".to_string());
    }
    if account.email != claims.email {
        return Err("Current OIDC session email does not match this account namespace".to_string());
    }

    require_future_oidc_expiry(ctx, claims)?;

    let refresh_after = timestamp_plus_ms(
        ctx.timestamp,
        ACCOUNT_AUTH_LEASE_REFRESH_THRESHOLD_MS as i64,
    );
    let expires_at = timestamp_plus_ms(ctx.timestamp, ACCOUNT_AUTH_LEASE_DURATION_MS as i64);
    let table = ctx.db.account_auth_lease();
    let existing = table.owner_identity().find(&ctx.sender());

    let lease = match existing {
        Some(row)
            if !force_refresh
                && row.active
                && row.account_id == account.id
                && row.expires_at > refresh_after =>
        {
            return Ok(row);
        }
        Some(row) => {
            let updated = AccountAuthLease {
                account_id: account.id,
                expires_at,
                active: true,
                updated_at: ctx.timestamp,
                ..row
            };
            table.id().update(updated)
        }
        None => table.insert(AccountAuthLease {
            id: 0,
            owner_identity: ctx.sender(),
            account_id: account.id,
            expires_at,
            active: true,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        }),
    };

    schedule_expiry(
        ctx,
        ScheduledExpiryKind::AccountAuthLease,
        lease.id,
        expires_at,
    );
    ensure_account_change_signal(ctx, account.id);

    Ok(lease)
}

/// Flip the lease's `active=false` and cancel its pending expiry. Used on logout and on the
/// `expire_scheduled` AccountAuthLease branch.
pub fn deactivate_lease(ctx: &ReducerContext, mut lease: AccountAuthLease) {
    cancel_expiry_for(ctx, ScheduledExpiryKind::AccountAuthLease, lease.id);
    if !lease.active {
        return;
    }
    lease.active = false;
    lease.updated_at = ctx.timestamp;
    ctx.db.account_auth_lease().id().update(lease);
}

pub fn deactivate_sender_lease(ctx: &ReducerContext) {
    if let Some(lease) = ctx
        .db
        .account_auth_lease()
        .owner_identity()
        .find(&ctx.sender())
    {
        deactivate_lease(ctx, lease);
    }
}
