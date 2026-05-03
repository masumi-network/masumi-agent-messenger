//! Procedure-side auth: resolve the caller's active lease, return the bound account_id.
//! Procedures get `ctx.timestamp`, so we additionally enforce `expires_at > now` rather than
//! relying solely on the `expire_scheduled` dispatcher having flipped `active=false`.

use spacetimedb::{Identity, Timestamp, TxContext};

use crate::tables::*;

pub fn caller_account_id(tx: &TxContext, sender: Identity, now: Timestamp) -> Option<u64> {
    let lease = tx.db.account_auth_lease().owner_identity().find(&sender)?;
    if !lease.active || lease.expires_at <= now {
        return None;
    }
    Some(lease.account_id)
}
