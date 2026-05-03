//! `list_contact_allowlist_entries` — paginated account allowlist rows beyond the capped view.
//! Cursor: `after_id?`.

use spacetimedb::ProcedureContext;

use crate::constants::MAX_CONTACT_ALLOWLIST_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn list_contact_allowlist_entries(
    ctx: &mut ProcedureContext,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<ContactAllowlistEntry> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let cap = limit
            .unwrap_or(MAX_CONTACT_ALLOWLIST_PAGE_SIZE)
            .min(MAX_CONTACT_ALLOWLIST_PAGE_SIZE) as usize;
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        tx.db
            .contact_allowlist_entry()
            .contact_allowlist_entry_account_id_id()
            .filter((account_id, start_id..))
            .take(cap)
            .collect()
    })
}
