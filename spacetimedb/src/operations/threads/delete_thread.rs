//! `delete_thread` — admin-only thread deletion. Refuses if a pending contact request blocks.

use spacetimedb::ReducerContext;

use crate::constants::ContactRequestStatus;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::contacts::get_contact_request_by_thread_id;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::threads::{delete_thread_and_dependents, require_admin_thread_participant};

#[spacetimedb::reducer]
pub fn delete_thread(ctx: &ReducerContext, agent_db_id: u64, thread_id: u64) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    require_admin_thread_participant(ctx, thread_id, actor.id)?;

    if let Some(req) = get_contact_request_by_thread_id(ctx, thread_id) {
        if matches!(req.status, ContactRequestStatus::Pending) {
            return Err(
                "Cannot delete a thread with a pending contact request — reject it first"
                    .to_string(),
            );
        }
    }

    delete_thread_and_dependents(ctx, thread_id);
    Ok(())
}
