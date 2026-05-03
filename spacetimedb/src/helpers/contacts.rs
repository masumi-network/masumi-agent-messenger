//! Direct-contact policy: when may agent A send to agent B without first creating a contact
//! request? Allowed if any of:
//! - allowlist entry (Agent kind matching B's public_identity, or Email kind matching B's
//!   email) on B's account
//! - pre-existing approved contact request between (A, B)
//! - an existing Direct thread where both agents are active participants
//! - same account (A and B are both owned by the caller)

use spacetimedb::ReducerContext;

use crate::constants::{ContactAllowlistKind, ContactRequestStatus, ThreadKind};
use crate::helpers::threads::direct_pair;
use crate::tables::*;

fn is_active_thread_participant(ctx: &ReducerContext, thread_id: u64, agent_db_id: u64) -> bool {
    ctx.db
        .thread_participant()
        .thread_participant_thread_id_agent_db_id()
        .filter((thread_id, agent_db_id))
        .next()
        .is_some_and(|participant| participant.active)
}

fn has_active_direct_thread(ctx: &ReducerContext, sender: &Agent, target: &Agent) -> bool {
    let (low, high) = direct_pair(sender.id, target.id);
    ctx.db
        .thread()
        .thread_direct_pair()
        .filter((low, high))
        .filter(|thread| matches!(thread.kind, ThreadKind::Direct))
        .any(|thread| {
            is_active_thread_participant(ctx, thread.id, sender.id)
                && is_active_thread_participant(ctx, thread.id, target.id)
        })
}

pub fn is_direct_contact_allowed(ctx: &ReducerContext, sender: &Agent, target: &Agent) -> bool {
    if sender.account_id == target.account_id {
        return true;
    }
    let agent_allowed = ctx
        .db
        .contact_allowlist_entry()
        .contact_allowlist_entry_account_id_kind_lookup_key()
        .filter((
            target.account_id,
            ContactAllowlistKind::Agent,
            &sender.public_identity[..],
        ))
        .next()
        .is_some();
    let email_allowed = ctx
        .db
        .contact_allowlist_entry()
        .contact_allowlist_entry_account_id_kind_lookup_key()
        .filter((
            target.account_id,
            ContactAllowlistKind::Email,
            &sender.email[..],
        ))
        .next()
        .is_some();
    if agent_allowed || email_allowed {
        return true;
    }
    if has_active_direct_thread(ctx, sender, target) {
        return true;
    }
    has_approved_contact_request(ctx, sender.id, target.id)
}

pub fn has_approved_contact_request(
    ctx: &ReducerContext,
    requester_agent_db_id: u64,
    target_agent_db_id: u64,
) -> bool {
    ctx.db
        .contact_request()
        .contact_request_requester_agent_db_id_target_agent_db_id_status()
        .filter((
            requester_agent_db_id,
            target_agent_db_id,
            ContactRequestStatus::Approved,
        ))
        .next()
        .is_some()
        || ctx
            .db
            .contact_request()
            .contact_request_target_agent_db_id_requester_agent_db_id_status()
            .filter((
                target_agent_db_id,
                requester_agent_db_id,
                ContactRequestStatus::Approved,
            ))
            .next()
            .is_some()
}

pub fn get_contact_request_by_thread_id(
    ctx: &ReducerContext,
    thread_id: u64,
) -> Option<ContactRequest> {
    ctx.db
        .contact_request()
        .contact_request_thread_id()
        .filter(thread_id)
        .next()
}

pub fn find_pending_contact_request(
    ctx: &ReducerContext,
    requester_agent_db_id: u64,
    target_agent_db_id: u64,
) -> Option<ContactRequest> {
    ctx.db
        .contact_request()
        .contact_request_requester_agent_db_id_target_agent_db_id_status()
        .filter((
            requester_agent_db_id,
            target_agent_db_id,
            ContactRequestStatus::Pending,
        ))
        .next()
}
