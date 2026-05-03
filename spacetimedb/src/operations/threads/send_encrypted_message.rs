//! `send_encrypted_message` — append a ciphertext message to a thread.
//!
//! **Fan-out reducer** — every active participant's `updated_at` and recency key are bumped at
//! the end so the thread surfaces in actor-scoped thread-list pages.

use spacetimedb::ReducerContext;

use crate::constants::{
    ContactRequestStatus, MessageCipherAlgorithm, RateLimitAction, ThreadSecretWrapAlgorithm,
    MAX_THREAD_FANOUT, THREAD_MESSAGE_RATE_MAX_PER_WINDOW, THREAD_MESSAGE_RATE_WINDOW_MS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::contacts::get_contact_request_by_thread_id;
use crate::helpers::envelopes::{
    require_exact_coverage, validate_and_insert_attached_envelopes, AttachedEnvelope,
};
use crate::helpers::messages::{insert_thread_message, InsertThreadMessageParams};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::thread_fanout::bump_active_participants;
use crate::helpers::threads::{
    get_active_thread_participants, require_active_thread_participant,
    thread_participant_recency_sort_key,
};
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct SecretEnvelopeAttachment {
    pub recipient_public_identity: String,
    pub recipient_encryption_key_version: u32,
    pub sender_encryption_key_version: u32,
    pub signing_key_version: u32,
    pub wrapped_secret_ciphertext: Vec<u8>,
    pub wrapped_secret_iv: Vec<u8>,
    pub wrap_algorithm: ThreadSecretWrapAlgorithm,
    pub signature: Vec<u8>,
}

impl From<&SecretEnvelopeAttachment> for AttachedEnvelope {
    fn from(s: &SecretEnvelopeAttachment) -> Self {
        AttachedEnvelope {
            recipient_public_identity: s.recipient_public_identity.clone(),
            recipient_encryption_key_version: s.recipient_encryption_key_version,
            sender_encryption_key_version: s.sender_encryption_key_version,
            signing_key_version: s.signing_key_version,
            wrapped_secret_ciphertext: s.wrapped_secret_ciphertext.clone(),
            wrapped_secret_iv: s.wrapped_secret_iv.clone(),
            wrap_algorithm: s.wrap_algorithm,
            signature: s.signature.clone(),
        }
    }
}

#[spacetimedb::reducer]
pub fn send_encrypted_message(
    ctx: &ReducerContext,
    agent_db_id: u64,
    thread_id: u64,
    secret_version: u32,
    signing_key_version: u32,
    sender_message_id: u64,
    ciphertext: Vec<u8>,
    iv: Vec<u8>,
    cipher_algorithm: MessageCipherAlgorithm,
    signature: Vec<u8>,
    reply_to_message_id: Option<u64>,
    attached_secret_envelopes: Vec<SecretEnvelopeAttachment>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let sender = get_owned_actor(ctx, agent_db_id, account.id)?;

    let bk = bucket_key(
        RateLimitAction::ThreadMessage,
        ctx.sender(),
        Some(&thread_id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ThreadMessage,
            owner_identity: ctx.sender(),
            window_ms: THREAD_MESSAGE_RATE_WINDOW_MS as i64,
            max_count: THREAD_MESSAGE_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Thread message rate limit exceeded; try again later".to_string());
    }

    if attached_secret_envelopes.len() > MAX_THREAD_FANOUT {
        return Err(format!(
            "attachedSecretEnvelopes may include at most {MAX_THREAD_FANOUT} entries"
        ));
    }

    let thread = ctx
        .db
        .thread()
        .id()
        .find(&thread_id)
        .ok_or_else(|| "Thread not found".to_string())?;
    let active_participants = get_active_thread_participants(ctx, thread_id);
    let sender_participant = require_active_thread_participant(ctx, thread_id, sender.id)?;

    let contact_request = get_contact_request_by_thread_id(ctx, thread_id);
    if let Some(req) = &contact_request {
        match req.status {
            ContactRequestStatus::Pending => {
                return Err(
                    "Pending direct-contact threads allow only one hidden pre-approval message"
                        .to_string(),
                );
            }
            ContactRequestStatus::Rejected | ContactRequestStatus::Cancelled => {
                return Err("Direct contact request was not approved for this thread".to_string());
            }
            ContactRequestStatus::Approved => {}
        }
    }

    let attaches_new_envelopes = !attached_secret_envelopes.is_empty();
    let last_sent_secret = sender_participant.last_sent_secret_version;
    let last_sent_seq = sender_participant.last_sent_seq;

    if last_sent_seq == 0 && !attaches_new_envelopes {
        return Err(
            "The first message for a sender in this thread must publish a secretVersion"
                .to_string(),
        );
    }
    if last_sent_seq > 0 && !attaches_new_envelopes {
        if last_sent_secret != secret_version {
            return Err(
                "Non-rotation messages must reuse the current sender secretVersion".to_string(),
            );
        }
    }
    if attaches_new_envelopes && secret_version <= last_sent_secret {
        return Err("Rotation messages must use a greater secretVersion".to_string());
    }

    if attaches_new_envelopes {
        let attached: Vec<AttachedEnvelope> =
            attached_secret_envelopes.iter().map(Into::into).collect();
        validate_and_insert_attached_envelopes(
            ctx,
            thread_id,
            thread.membership_version,
            &sender,
            secret_version,
            &active_participants,
            &attached,
        )?;
    } else {
        require_exact_coverage(
            ctx,
            thread_id,
            thread.membership_version,
            sender.id,
            secret_version,
            &active_participants,
        )?;
    }

    let next_sender_seq = sender_participant.last_sent_seq.saturating_add(1);
    let message = insert_thread_message(
        ctx,
        InsertThreadMessageParams {
            thread: &thread,
            sender: &sender,
            secret_version,
            signing_key_version,
            sender_message_id,
            ciphertext: &ciphertext,
            iv: &iv,
            cipher_algorithm,
            signature: &signature,
            reply_to_message_id,
            attaches_new_envelopes,
        },
    )?;

    let updated_sender = ThreadParticipant {
        last_sent_seq: next_sender_seq,
        last_sent_secret_version: secret_version,
        last_read_message_id: message.id.max(sender_participant.last_read_message_id),
        updated_at: ctx.timestamp,
        active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
        ..sender_participant
    };
    ctx.db.thread_participant().id().update(updated_sender);

    bump_active_participants(ctx, thread_id);
    Ok(())
}
