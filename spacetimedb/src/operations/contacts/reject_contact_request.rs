//! `reject_contact_request` — target declines the contact request and the thread is deleted
//! along with its hidden message(s).

use spacetimedb::ReducerContext;

use crate::constants::ContactRequestStatus;
use crate::helpers::account_signals::bump_contact_requests_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::retention::{
    schedule_resolved_request_tombstone, ResolvedRequestTombstoneTarget,
};
use crate::helpers::threads::delete_thread_and_dependents_preserving_contact_requests;
use crate::helpers::time::{descending_timestamp_key, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn reject_contact_request(
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
    if request.target_agent_db_id != actor.id {
        return Err("Caller is not the target of this contact request".to_string());
    }
    if !matches!(request.status, ContactRequestStatus::Pending) {
        return Err("Contact request is not pending".to_string());
    }

    let resolved = ContactRequest {
        status: ContactRequestStatus::Rejected,
        resolved_at: Some(ctx.timestamp),
        resolved_by_agent_db_id: Some(actor.id),
        updated_at: ctx.timestamp,
        requester_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        target_resolved_sort_key: descending_timestamp_key(ctx.timestamp),
        requester_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        target_pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        ..request.clone()
    };
    ctx.db.contact_request().id().update(resolved);
    bump_contact_requests_signal(ctx, request.requester_account_id);
    bump_contact_requests_signal(ctx, request.target_account_id);
    schedule_resolved_request_tombstone(
        ctx,
        ResolvedRequestTombstoneTarget::ContactRequest,
        request.id,
    );

    delete_thread_and_dependents_preserving_contact_requests(ctx, request.thread_id);
    Ok(())
}
