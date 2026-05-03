//! `request_direct_contact` — start a direct thread with a first hidden message in a single
//! transaction.
//!
//! The first-contact message is stored before approval, but the target is not inserted as a thread
//! participant until approval. Pending direct-contact threads allow exactly one hidden pre-approval
//! message. Only identity-pinning fields are stored on the contact-request row; display fields are
//! resolved live from the agent row.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ContactRequestStatus, MessageCipherAlgorithm, RateLimitAction, ThreadKind,
    CONTACT_REQUEST_RATE_MAX_PER_WINDOW, CONTACT_REQUEST_RATE_WINDOW_MS, MAX_THREAD_TITLE_CHARS,
};
use crate::helpers::account_signals::bump_contact_requests_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::{get_owned_actor, get_required_agent_by_public_identity};
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::contacts::{find_pending_contact_request, is_direct_contact_allowed};
use crate::helpers::envelopes::{
    validate_and_insert_attached_envelopes_for_agents, AttachedEnvelope,
};
use crate::helpers::messages::{insert_thread_message, InsertThreadMessageParams};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{
    direct_pair, ensure_thread_participant, thread_participant_recency_sort_key,
};
use crate::helpers::time::{descending_timestamp_key, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::helpers::validate::normalize_optional;
use crate::operations::threads::send_encrypted_message::SecretEnvelopeAttachment;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn request_direct_contact(
    ctx: &ReducerContext,
    agent_db_id: u64,
    other_agent_public_identity: String,
    thread_id: u64,
    title: Option<String>,
    secret_version: u32,
    signing_key_version: u32,
    sender_message_id: u64,
    ciphertext: Vec<u8>,
    iv: Vec<u8>,
    cipher_algorithm: MessageCipherAlgorithm,
    signature: Vec<u8>,
    attached_secret_envelopes: Vec<SecretEnvelopeAttachment>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;
    let other = get_required_agent_by_public_identity(ctx, &other_agent_public_identity)?;

    if other.id == actor.id {
        return Err("Direct threads require a second actor".to_string());
    }
    if thread_id == 0 {
        return Err("threadId must be non-zero".to_string());
    }
    if !crate::helpers::threads::is_client_generated_thread_id(thread_id) {
        return Err("threadId must be a client-generated thread id".to_string());
    }
    if ctx.db.thread().id().find(&thread_id).is_some() {
        return Err(
            "Thread id collision detected. Generate a new thread id and try again.".to_string(),
        );
    }
    if ctx
        .db
        .contact_request()
        .contact_request_thread_id()
        .filter(thread_id)
        .next()
        .is_some()
    {
        return Err(
            "Thread id was already used for a contact request. Generate a new thread id and try again."
                .to_string(),
        );
    }

    let bk = bucket_key(
        RateLimitAction::ContactRequest,
        ctx.sender(),
        Some(&actor.id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ContactRequest,
            owner_identity: ctx.sender(),
            window_ms: CONTACT_REQUEST_RATE_WINDOW_MS as i64,
            max_count: CONTACT_REQUEST_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Contact request rate limit exceeded; try again later".to_string());
    }

    if is_direct_contact_allowed(ctx, &actor, &other) {
        return Err("Direct contact is already allowed for this actor pair".to_string());
    }
    if find_pending_contact_request(ctx, actor.id, other.id).is_some() {
        return Err("A pending contact request already exists for this actor pair".to_string());
    }

    let (low, high) = direct_pair(actor.id, other.id);
    let normalized_title = normalize_optional(title.as_deref(), MAX_THREAD_TITLE_CHARS, "title")?;

    let thread = ctx.db.thread().insert(Thread {
        id: thread_id,
        kind: ThreadKind::Direct,
        direct_low_agent_db_id: low,
        direct_high_agent_db_id: high,
        title: normalized_title,
        creator_agent_db_id: actor.id,
        membership_version: 1,
        active_participant_count: 0,
        last_message_id: 0,
        message_count: 0,
        last_message_at: ctx.timestamp,
        message_retention_ms: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    let actor_participant = ensure_thread_participant(ctx, &thread, &actor, true)?;

    // The target receives only the contact_request row before approval. Their secret envelope is
    // stored now so the first message decrypts after approve_contact_request creates membership.
    let expected_recipients = vec![actor.clone(), other.clone()];
    let attached: Vec<AttachedEnvelope> =
        attached_secret_envelopes.iter().map(Into::into).collect();
    validate_and_insert_attached_envelopes_for_agents(
        ctx,
        thread.id,
        thread.membership_version,
        &actor,
        secret_version,
        &expected_recipients,
        &attached,
    )?;

    let next_sender_seq = actor_participant.last_sent_seq.saturating_add(1);
    let message = insert_thread_message(
        ctx,
        InsertThreadMessageParams {
            thread: &thread,
            sender: &actor,
            secret_version,
            signing_key_version,
            sender_message_id,
            ciphertext: &ciphertext,
            iv: &iv,
            cipher_algorithm,
            signature: &signature,
            reply_to_message_id: None,
            attaches_new_envelopes: true,
        },
    )?;
    ctx.db.thread_participant().id().update(ThreadParticipant {
        last_sent_seq: next_sender_seq,
        last_sent_secret_version: secret_version,
        last_read_message_id: message.id.max(actor_participant.last_read_message_id),
        updated_at: ctx.timestamp,
        active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
        ..actor_participant
    });

    ctx.db.contact_request().insert(ContactRequest {
        id: 0,
        thread_id: thread.id,
        requester_agent_db_id: actor.id,
        target_agent_db_id: other.id,
        requester_account_id: actor.account_id,
        target_account_id: other.account_id,
        requester_public_identity: actor.public_identity.clone(),
        requester_slug: actor.slug.clone(),
        target_public_identity: other.public_identity.clone(),
        target_slug: other.slug.clone(),
        status: ContactRequestStatus::Pending,
        requester_resolved_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        target_resolved_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        requester_pending_sort_key: descending_timestamp_key(ctx.timestamp),
        target_pending_sort_key: descending_timestamp_key(ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        resolved_at: None,
        resolved_by_agent_db_id: None,
        requester_hidden_at: None,
    });
    bump_contact_requests_signal(ctx, actor.account_id);
    bump_contact_requests_signal(ctx, other.account_id);

    bump_active_participants(ctx, thread.id);
    Ok(())
}
