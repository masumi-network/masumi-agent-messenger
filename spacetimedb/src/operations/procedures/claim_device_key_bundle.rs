//! `claim_device_key_bundle` — recipient device atomically reads the bundle targeted at it AND
//! marks it `consumed_at = now`. Procedure (not reducer) so we can return the bundle bytes.
//!
//! Auth-gated: caller must own the target device (`device.account_id == caller account`).

use spacetimedb::ProcedureContext;

use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn claim_device_key_bundle(
    ctx: &mut ProcedureContext,
    device_id: String,
) -> Vec<DeviceKeyBundle> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        // Caller must own the device.
        let device_owned = tx
            .db
            .device()
            .device_id()
            .find(&device_id)
            .map(|d| d.account_id == account_id)
            .unwrap_or(false);
        if !device_owned {
            return Vec::new();
        }

        let claimable: Vec<DeviceKeyBundle> = tx
            .db
            .device_key_bundle()
            .device_key_bundle_target_device_id_pending_sort_key()
            .filter((&device_id[..], ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
            .filter(|b| b.account_id == account_id && b.expires_at > timestamp)
            .collect();

        // Mark each one consumed in this same transaction.
        for bundle in &claimable {
            let updated = DeviceKeyBundle {
                consumed_at: Some(timestamp),
                pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
                updated_at: timestamp,
                ..bundle.clone()
            };
            tx.db.device_key_bundle().id().update(updated);
        }

        claimable
    })
}
