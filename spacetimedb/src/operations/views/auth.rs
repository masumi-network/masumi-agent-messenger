//! View-side auth gate: resolve the caller's active lease, return the bound `account_id`.
//!
//! Views can't read wall-clock time, so we trust the lease's `active=true` flag (the
//! `expire_scheduled` dispatcher flips it to false at `expires_at`). If no active lease, the
//! caller is anonymous from this view's perspective.

use spacetimedb::ViewContext;

use crate::tables::*;

pub fn caller_account_id(ctx: &ViewContext) -> Option<u64> {
    let lease = ctx
        .db
        .account_auth_lease()
        .owner_identity()
        .find(&ctx.sender())?;
    if !lease.active {
        return None;
    }
    Some(lease.account_id)
}
