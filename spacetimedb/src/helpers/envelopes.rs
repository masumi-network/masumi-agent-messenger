//! Thread secret envelope validation + insert.
//!
//! When `attaches_new_envelopes = true`, the message body must be accompanied by exactly one
//! envelope per active participant (sender → recipient pairs covering the active set).
//! Off-rotation messages must instead show that an envelope already exists for every active
//! `(sender, recipient)` at the current `secret_version`.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ThreadSecretWrapAlgorithm, AES_GCM_IV_BYTES, MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES,
    SIGNATURE_BYTES,
};
use crate::helpers::agents::get_required_agent_by_public_identity;
use crate::helpers::validate::{ensure_byte_len, ensure_exact_byte_len};
use crate::tables::*;

#[derive(Debug, Clone)]
pub struct AttachedEnvelope {
    pub recipient_public_identity: String,
    pub recipient_encryption_key_version: u32,
    pub sender_encryption_key_version: u32,
    pub signing_key_version: u32,
    pub wrapped_secret_ciphertext: Vec<u8>,
    pub wrapped_secret_iv: Vec<u8>,
    pub wrap_algorithm: ThreadSecretWrapAlgorithm,
    pub signature: Vec<u8>,
}

pub fn validate_and_insert_attached_envelopes(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender: &Agent,
    secret_version: u32,
    active_participants: &[ThreadParticipant],
    attached: &[AttachedEnvelope],
) -> Result<(), String> {
    let expected_recipient_ids = active_participants
        .iter()
        .map(|p| p.agent_db_id)
        .collect::<std::collections::BTreeSet<_>>();
    validate_and_insert_attached_envelopes_for_recipient_ids(
        ctx,
        thread_id,
        membership_version,
        sender,
        secret_version,
        &expected_recipient_ids,
        attached,
    )
}

pub fn validate_and_insert_attached_envelopes_for_agents(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender: &Agent,
    secret_version: u32,
    expected_recipients: &[Agent],
    attached: &[AttachedEnvelope],
) -> Result<(), String> {
    let expected_recipient_ids = expected_recipients
        .iter()
        .map(|agent| agent.id)
        .collect::<std::collections::BTreeSet<_>>();
    validate_and_insert_attached_envelopes_for_recipient_ids(
        ctx,
        thread_id,
        membership_version,
        sender,
        secret_version,
        &expected_recipient_ids,
        attached,
    )
}

fn validate_and_insert_attached_envelopes_for_recipient_ids(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender: &Agent,
    secret_version: u32,
    expected_recipient_ids: &std::collections::BTreeSet<u64>,
    attached: &[AttachedEnvelope],
) -> Result<(), String> {
    if attached.is_empty() {
        return Err("Rotation message must attach at least one secret envelope".to_string());
    }

    if attached.len() != expected_recipient_ids.len() {
        return Err(
            "Rotation envelopes must cover every expected recipient exactly once".to_string(),
        );
    }

    let existing_for_version = ctx
        .db
        .thread_secret_envelope()
        .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
        .filter((thread_id, membership_version, sender.id, secret_version))
        .next()
        .is_some();
    if existing_for_version {
        return Err("secretVersion is already published for this sender".to_string());
    }

    let mut covered: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    let mut recipient_versions: Vec<(u64, u32)> = Vec::new();
    for env in attached {
        let recipient = get_required_agent_by_public_identity(ctx, &env.recipient_public_identity)?;
        if !expected_recipient_ids.contains(&recipient.id) {
            return Err(format!(
                "Envelope recipient {} is not expected for this message",
                env.recipient_public_identity
            ));
        }
        if !covered.insert(recipient.id) {
            return Err(format!(
                "Duplicate envelope for recipient {}",
                env.recipient_public_identity
            ));
        }

        let dup = ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_recipient_agent_db_id_secret_version()
            .filter((
                thread_id,
                membership_version,
                sender.id,
                recipient.id,
                secret_version,
            ))
            .next()
            .is_some();
        if dup {
            return Err(
                "Envelope already exists for this (thread, membership, sender, recipient, version) tuple"
                    .to_string(),
            );
        }

        validate_envelope_payload(ctx, sender, &recipient, env)?;
        recipient_versions.push((recipient.id, recipient.current_key_bundle_version));

        ctx.db
            .thread_secret_envelope()
            .insert(ThreadSecretEnvelope {
                id: 0,
                thread_id,
                membership_version,
                secret_version,
                sender_agent_db_id: sender.id,
                recipient_agent_db_id: recipient.id,
                sender_account_id: sender.account_id,
                recipient_account_id: recipient.account_id,
                sender_encryption_key_version: env.sender_encryption_key_version,
                recipient_encryption_key_version: env.recipient_encryption_key_version,
                signing_key_version: env.signing_key_version,
                wrapped_secret_ciphertext: env.wrapped_secret_ciphertext.clone(),
                wrapped_secret_iv: env.wrapped_secret_iv.clone(),
                signature: env.signature.clone(),
                wrap_algorithm: env.wrap_algorithm,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
    }

    for recipient_id in expected_recipient_ids {
        if !covered.contains(recipient_id) {
            return Err(format!(
                "Rotation envelope set is missing recipient agent {}",
                recipient_id
            ));
        }
    }

    upsert_secret_coverage(
        ctx,
        thread_id,
        membership_version,
        sender,
        secret_version,
        &recipient_versions,
    );

    Ok(())
}

pub fn require_exact_coverage(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender_id: u64,
    secret_version: u32,
    active_participants: &[ThreadParticipant],
) -> Result<(), String> {
    let sender = ctx
        .db
        .agent()
        .id()
        .find(&sender_id)
        .ok_or_else(|| "Sender agent not found".to_string())?;
    let recipient_versions = collect_participant_key_versions(ctx, active_participants)?;
    if coverage_cache_matches(
        ctx,
        thread_id,
        membership_version,
        &sender,
        secret_version,
        &recipient_versions,
    ) {
        return Ok(());
    }

    let mut seen = std::collections::BTreeSet::new();
    for p in active_participants {
        let envelope = ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_recipient_agent_db_id_secret_version()
            .filter((
                thread_id,
                membership_version,
                sender_id,
                p.agent_db_id,
                secret_version,
            ))
            .next();
        let Some(envelope) = envelope else {
            return Err(format!(
                "Off-rotation message is missing envelope for recipient {}",
                p.agent_db_id
            ));
        };
        if !seen.insert(envelope.recipient_agent_db_id) {
            return Err("secretVersion includes duplicate recipient envelopes".to_string());
        }
        let recipient = ctx
            .db
            .agent()
            .id()
            .find(&p.agent_db_id)
            .ok_or_else(|| "Envelope recipient agent not found".to_string())?;
        validate_stored_envelope_versions(ctx, &sender, &recipient, &envelope)?;
    }

    let extra = ctx
        .db
        .thread_secret_envelope()
        .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
        .filter((thread_id, membership_version, sender_id, secret_version))
        .any(|row| !seen.contains(&row.recipient_agent_db_id));
    if extra {
        return Err("secretVersion includes envelopes for inactive participants".to_string());
    }
    upsert_secret_coverage(
        ctx,
        thread_id,
        membership_version,
        &sender,
        secret_version,
        &recipient_versions,
    );
    Ok(())
}

fn collect_participant_key_versions(
    ctx: &ReducerContext,
    active_participants: &[ThreadParticipant],
) -> Result<Vec<(u64, u32)>, String> {
    let mut recipient_versions = Vec::with_capacity(active_participants.len());
    for p in active_participants {
        let recipient = ctx
            .db
            .agent()
            .id()
            .find(&p.agent_db_id)
            .ok_or_else(|| "Envelope recipient agent not found".to_string())?;
        recipient_versions.push((recipient.id, recipient.current_key_bundle_version));
    }
    Ok(recipient_versions)
}

fn coverage_cache_matches(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender: &Agent,
    secret_version: u32,
    recipient_versions: &[(u64, u32)],
) -> bool {
    let fingerprint = recipient_versions_fingerprint(recipient_versions);
    ctx.db
        .thread_secret_coverage()
        .thread_secret_coverage_tuple()
        .filter((thread_id, membership_version, sender.id, secret_version))
        .any(|coverage| {
            coverage.participant_count == recipient_versions.len() as u32
                && coverage.sender_key_bundle_version == sender.current_key_bundle_version
                && coverage.recipient_versions_fingerprint == fingerprint
        })
}

fn upsert_secret_coverage(
    ctx: &ReducerContext,
    thread_id: u64,
    membership_version: u64,
    sender: &Agent,
    secret_version: u32,
    recipient_versions: &[(u64, u32)],
) {
    let fingerprint = recipient_versions_fingerprint(recipient_versions);
    let table = ctx.db.thread_secret_coverage();
    if let Some(existing) = table
        .thread_secret_coverage_tuple()
        .filter((thread_id, membership_version, sender.id, secret_version))
        .next()
    {
        table.id().update(ThreadSecretCoverage {
            participant_count: recipient_versions.len() as u32,
            sender_key_bundle_version: sender.current_key_bundle_version,
            recipient_versions_fingerprint: fingerprint,
            updated_at: ctx.timestamp,
            ..existing
        });
        return;
    }
    table.insert(ThreadSecretCoverage {
        id: 0,
        thread_id,
        membership_version,
        sender_agent_db_id: sender.id,
        secret_version,
        participant_count: recipient_versions.len() as u32,
        sender_key_bundle_version: sender.current_key_bundle_version,
        recipient_versions_fingerprint: fingerprint,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
}

fn recipient_versions_fingerprint(recipient_versions: &[(u64, u32)]) -> String {
    let mut sorted = recipient_versions.to_vec();
    sorted.sort_unstable();
    let mut out = String::new();
    for (recipient_id, key_version) in sorted {
        out.push_str(&recipient_id.to_string());
        out.push(':');
        out.push_str(&key_version.to_string());
        out.push(';');
    }
    out
}

fn validate_envelope_payload(
    ctx: &ReducerContext,
    sender: &Agent,
    recipient: &Agent,
    env: &AttachedEnvelope,
) -> Result<(), String> {
    if env.sender_encryption_key_version != sender.current_key_bundle_version {
        return Err(
            "senderEncryptionKeyVersion must match the sender's current encryption key version"
                .to_string(),
        );
    }
    if env.signing_key_version != sender.current_key_bundle_version {
        return Err(
            "signingKeyVersion must match the sender's current signing key version".to_string(),
        );
    }
    if env.recipient_encryption_key_version != recipient.current_key_bundle_version {
        return Err(
            "recipientEncryptionKeyVersion must match the recipient's current encryption key version"
                .to_string(),
        );
    }

    let bundles = ctx.db.agent_key_bundle();
    let sender_encryption_bundle = bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((sender.id, env.sender_encryption_key_version))
        .next()
        .is_some();
    if !sender_encryption_bundle {
        return Err(
            "senderEncryptionKeyVersion was not found in the sender key bundle history".to_string(),
        );
    }

    let sender_signing_bundle = bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((sender.id, env.signing_key_version))
        .next()
        .is_some();
    if !sender_signing_bundle {
        return Err("signingKeyVersion was not found in the sender key bundle history".to_string());
    }

    let recipient_encryption_bundle = bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((recipient.id, env.recipient_encryption_key_version))
        .next()
        .is_some();
    if !recipient_encryption_bundle {
        return Err(
            "recipientEncryptionKeyVersion was not found in the recipient key bundle history"
                .to_string(),
        );
    }

    ensure_byte_len(
        &env.wrapped_secret_ciphertext,
        MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES,
        "wrappedSecretCiphertext",
    )?;
    ensure_exact_byte_len(&env.wrapped_secret_iv, AES_GCM_IV_BYTES, "wrappedSecretIv")?;
    ensure_exact_byte_len(&env.signature, SIGNATURE_BYTES, "signature")?;

    Ok(())
}

fn validate_stored_envelope_versions(
    ctx: &ReducerContext,
    sender: &Agent,
    recipient: &Agent,
    envelope: &ThreadSecretEnvelope,
) -> Result<(), String> {
    if envelope.sender_encryption_key_version != sender.current_key_bundle_version
        || envelope.signing_key_version != sender.current_key_bundle_version
        || envelope.recipient_encryption_key_version != recipient.current_key_bundle_version
    {
        return Err(
            "Sender or recipient key rotated since this secretVersion was published. Rotate the sender secret by attaching fresh envelopes to the next message."
                .to_string(),
        );
    }

    let bundles = ctx.db.agent_key_bundle();
    if bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((sender.id, envelope.sender_encryption_key_version))
        .next()
        .is_none()
    {
        return Err(
            "senderEncryptionKeyVersion was not found in the sender key bundle history".to_string(),
        );
    }
    if bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((sender.id, envelope.signing_key_version))
        .next()
        .is_none()
    {
        return Err("signingKeyVersion was not found in the sender key bundle history".to_string());
    }
    if bundles
        .agent_key_bundle_agent_db_id_key_bundle_version()
        .filter((recipient.id, envelope.recipient_encryption_key_version))
        .next()
        .is_none()
    {
        return Err(
            "recipientEncryptionKeyVersion was not found in the recipient key bundle history"
                .to_string(),
        );
    }

    Ok(())
}
