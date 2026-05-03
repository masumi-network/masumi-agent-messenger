//! `list_owned_devices` — paginated devices beyond the capped live view.
//! Cursor: `after_id?`.

use spacetimedb::ProcedureContext;

use crate::constants::MAX_DEVICE_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn list_owned_devices(
    ctx: &mut ProcedureContext,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<Device> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let cap = limit
            .unwrap_or(MAX_DEVICE_PAGE_SIZE)
            .min(MAX_DEVICE_PAGE_SIZE) as usize;
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        tx.db
            .device()
            .device_account_id_id()
            .filter((account_id, start_id..))
            .take(cap)
            .collect()
    })
}
