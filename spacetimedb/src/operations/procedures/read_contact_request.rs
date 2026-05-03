//! `read_contact_request` — fetch one contact request by id if it belongs to the caller.

use spacetimedb::ProcedureContext;

use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn read_contact_request(ctx: &mut ProcedureContext, request_id: u64) -> Vec<ContactRequest> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let Some(request) = tx.db.contact_request().id().find(&request_id) else {
            return Vec::new();
        };
        let owns_requester = request.requester_account_id == account_id;
        let owns_target = request.target_account_id == account_id;

        if owns_requester && request.requester_hidden_at.is_some() {
            return Vec::new();
        }
        if owns_requester || owns_target {
            return vec![request];
        }
        Vec::new()
    })
}
