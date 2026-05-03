//! `cancel_contact_request` — requester cancels an outgoing pending request or hides a rejected
//! request from their own side.

use spacetimedb::ReducerContext;

use crate::constants::ContactRequestStatus;
use crate::helpers::account_signals::bump_contact_requests_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::threads::delete_thread_and_dependents;
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn cancel_contact_request(
    ctx: &ReducerContext,
    agent_db_id: u64,
    request_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let request = ctx
        .db
        .contact_request()
        .id()
        .find(&request_id)
        .ok_or_else(|| "Contact request not found".to_string())?;
    if request.requester_agent_db_id != actor.id {
        return Err("Only the requester may cancel this contact request".to_string());
    }

    match request.status {
        ContactRequestStatus::Pending => {
            ctx.db.contact_request().id().update(ContactRequest {
                status: ContactRequestStatus::Cancelled,
                requester_hidden_at: Some(ctx.timestamp),
                updated_at: ctx.timestamp,
                requester_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
                target_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
                ..request.clone()
            });
            bump_contact_requests_signal(ctx, request.requester_account_id);
            bump_contact_requests_signal(ctx, request.target_account_id);
            delete_thread_and_dependents(ctx, request.thread_id);
        }
        ContactRequestStatus::Rejected => {
            if request.requester_hidden_at.is_none() {
                ctx.db.contact_request().id().update(ContactRequest {
                    requester_hidden_at: Some(ctx.timestamp),
                    updated_at: ctx.timestamp,
                    requester_resolved_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
                    ..request
                });
                bump_contact_requests_signal(ctx, account.id);
            }
        }
        ContactRequestStatus::Approved => {
            return Err(
                "Approved contact requests cannot be canceled; delete the direct thread instead"
                    .to_string(),
            );
        }
        ContactRequestStatus::Cancelled => {}
    }

    Ok(())
}
