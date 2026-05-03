//! `account_auth_lease` — server-side auth gate for views.
//!
//! Views can't read wall-clock time or OIDC claims; they need a stored bool to know if the
//! caller is authenticated. The lease is refreshed on connect and on a small set of identity
//! reducers; expired by the unified `scheduledExpiry` dispatcher (kind = `AccountAuthLease`).
//!
//! 1:1 with `account` on `owner_identity` (also unique). `account_id` is kept on the lease to
//! save a lookup hop in reducers.

use spacetimedb::{Identity, Timestamp};

#[spacetimedb::table(accessor = account_auth_lease,
    index(accessor = account_auth_lease_account_id, btree(columns = [account_id])),
)]
#[derive(Debug, Clone)]
pub struct AccountAuthLease {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub owner_identity: Identity,

    pub account_id: u64,

    pub expires_at: Timestamp,

    pub active: bool,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
