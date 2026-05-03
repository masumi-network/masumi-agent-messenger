//! Bounded retention and archival helpers driven by `scheduled_expiry`.

use spacetimedb::ReducerContext;

use crate::constants::{
    ChannelJoinRequestStatus, ContactRequestStatus, ScheduledExpiryKind, ThreadInviteStatus,
    AGENT_KEY_BUNDLE_ARCHIVE_BATCH_SIZE, AGENT_KEY_BUNDLE_RETAIN_RECENT,
    MAX_THREAD_MESSAGE_RETENTION_MS, MESSAGE_EXPIRY_CLEANUP_BATCH_SIZE,
    RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS, THREAD_SECRET_ENVELOPE_GC_BATCH_SIZE,
    THREAD_SECRET_ENVELOPE_GC_RETRY_DELAY_MS,
};
use crate::helpers::account_signals::{
    bump_channel_join_requests_signal, bump_contact_requests_signal, bump_thread_invites_signal,
};
use crate::helpers::scheduling::{cancel_expiry_for, schedule_expiry};
use crate::helpers::time::{is_timestamp_expired, timestamp_plus_ms};
use crate::tables::*;

const TOMBSTONE_TAG_CONTACT_REQUEST: u64 = 1u64 << 62;
const TOMBSTONE_TAG_THREAD_INVITE: u64 = 2u64 << 62;
const TOMBSTONE_TAG_CHANNEL_JOIN_REQUEST: u64 = 3u64 << 62;
const TOMBSTONE_ID_MASK: u64 = (1u64 << 62) - 1;

#[derive(Debug, Clone, Copy)]
pub enum ResolvedRequestTombstoneTarget {
    ContactRequest,
    ThreadInvite,
    ChannelJoinRequest,
}

fn retention_delay_ms(retention_ms: u64) -> i64 {
    retention_ms.min(MAX_THREAD_MESSAGE_RETENTION_MS) as i64
}

fn tombstone_target_id(target: ResolvedRequestTombstoneTarget, row_id: u64) -> u64 {
    let tag = match target {
        ResolvedRequestTombstoneTarget::ContactRequest => TOMBSTONE_TAG_CONTACT_REQUEST,
        ResolvedRequestTombstoneTarget::ThreadInvite => TOMBSTONE_TAG_THREAD_INVITE,
        ResolvedRequestTombstoneTarget::ChannelJoinRequest => TOMBSTONE_TAG_CHANNEL_JOIN_REQUEST,
    };
    tag | (row_id & TOMBSTONE_ID_MASK)
}

fn decode_tombstone_target(target_id: u64) -> Option<(ResolvedRequestTombstoneTarget, u64)> {
    let tag = target_id & !TOMBSTONE_ID_MASK;
    let row_id = target_id & TOMBSTONE_ID_MASK;
    let target = match tag {
        TOMBSTONE_TAG_CONTACT_REQUEST => ResolvedRequestTombstoneTarget::ContactRequest,
        TOMBSTONE_TAG_THREAD_INVITE => ResolvedRequestTombstoneTarget::ThreadInvite,
        TOMBSTONE_TAG_CHANNEL_JOIN_REQUEST => ResolvedRequestTombstoneTarget::ChannelJoinRequest,
        _ => return None,
    };
    Some((target, row_id))
}

pub fn schedule_resolved_request_tombstone(
    ctx: &ReducerContext,
    target: ResolvedRequestTombstoneTarget,
    row_id: u64,
) {
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::ResolvedRequestTombstone,
        tombstone_target_id(target, row_id),
        timestamp_plus_ms(
            ctx.timestamp,
            RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS as i64,
        ),
    );
}

pub fn schedule_next_message_expiry(ctx: &ReducerContext, thread_id: u64) {
    let Some(thread) = ctx.db.thread().id().find(&thread_id) else {
        cancel_expiry_for(ctx, ScheduledExpiryKind::MessageExpiry, thread_id);
        return;
    };
    let Some(retention_ms) = thread.message_retention_ms else {
        cancel_expiry_for(ctx, ScheduledExpiryKind::MessageExpiry, thread_id);
        return;
    };
    let Some(oldest_message) = ctx
        .db
        .message()
        .message_thread_id_id()
        .filter((thread_id, 0u64..))
        .next()
    else {
        cancel_expiry_for(ctx, ScheduledExpiryKind::MessageExpiry, thread_id);
        return;
    };
    let expires_at = timestamp_plus_ms(oldest_message.created_at, retention_delay_ms(retention_ms));
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::MessageExpiry,
        thread_id,
        if expires_at <= ctx.timestamp {
            ctx.timestamp
        } else {
            expires_at
        },
    );
}

pub fn cleanup_message_expiry_batch(ctx: &ReducerContext, thread_id: u64) {
    let Some(thread) = ctx.db.thread().id().find(&thread_id) else {
        cancel_expiry_for(ctx, ScheduledExpiryKind::MessageExpiry, thread_id);
        return;
    };
    let Some(retention_ms) = thread.message_retention_ms else {
        cancel_expiry_for(ctx, ScheduledExpiryKind::MessageExpiry, thread_id);
        return;
    };

    let mut sender_agent_ids = std::collections::BTreeSet::new();
    let mut envelope_tuples = Vec::new();
    let mut to_delete = Vec::new();
    for message in ctx
        .db
        .message()
        .message_thread_id_id()
        .filter((thread_id, 0u64..))
        .take(MESSAGE_EXPIRY_CLEANUP_BATCH_SIZE)
    {
        let expires_at = timestamp_plus_ms(message.created_at, retention_delay_ms(retention_ms));
        if !is_timestamp_expired(expires_at, ctx.timestamp) {
            break;
        }
        sender_agent_ids.insert(message.sender_agent_db_id);
        if message.attaches_new_envelopes {
            envelope_tuples.push((
                message.membership_version,
                message.sender_agent_db_id,
                message.secret_version,
            ));
        }
        to_delete.push(message.id);
    }

    for (membership_version, sender_agent_db_id, secret_version) in envelope_tuples {
        let envelope_ids: Vec<u64> = ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
            .filter((
                thread_id,
                membership_version,
                sender_agent_db_id,
                secret_version,
            ))
            .map(|env| env.id)
            .collect();
        for envelope_id in envelope_ids {
            ctx.db.thread_secret_envelope().id().delete(&envelope_id);
        }
        let coverage_ids: Vec<u64> = ctx
            .db
            .thread_secret_coverage()
            .thread_secret_coverage_tuple()
            .filter((
                thread_id,
                membership_version,
                sender_agent_db_id,
                secret_version,
            ))
            .map(|coverage| coverage.id)
            .collect();
        for coverage_id in coverage_ids {
            ctx.db.thread_secret_coverage().id().delete(&coverage_id);
        }
    }

    for message_id in &to_delete {
        ctx.db.message().id().delete(message_id);
    }
    for sender_agent_id in sender_agent_ids {
        schedule_agent_key_bundle_archive(ctx, sender_agent_id);
    }
    if !to_delete.is_empty() {
        schedule_thread_secret_envelope_gc(ctx, thread_id);
    }
    schedule_next_message_expiry(ctx, thread_id);
}

pub fn schedule_thread_secret_envelope_gc(ctx: &ReducerContext, thread_id: u64) {
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::ThreadSecretEnvelopeGc,
        thread_id,
        ctx.timestamp,
    );
}

pub fn cleanup_thread_secret_envelope_gc_batch(ctx: &ReducerContext, thread_id: u64) {
    let active_participants: Vec<ThreadParticipant> = ctx
        .db
        .thread_participant()
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .collect();
    let Some(min_read_message_id) = active_participants
        .iter()
        .map(|p| p.last_read_message_id)
        .min()
    else {
        return;
    };
    if min_read_message_id == 0 {
        return;
    }

    let mut deleted = 0usize;
    let upper_message_id = min_read_message_id.saturating_add(1);
    for message in ctx
        .db
        .message()
        .message_thread_id_attaches_new_envelopes_id()
        .filter((thread_id, true, 0u64..upper_message_id))
    {
        if deleted >= THREAD_SECRET_ENVELOPE_GC_BATCH_SIZE {
            break;
        }
        let remaining = THREAD_SECRET_ENVELOPE_GC_BATCH_SIZE - deleted;
        let envelope_ids: Vec<u64> = ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
            .filter((
                thread_id,
                message.membership_version,
                message.sender_agent_db_id,
                message.secret_version,
            ))
            .take(remaining)
            .map(|env| env.id)
            .collect();
        for envelope_id in &envelope_ids {
            ctx.db.thread_secret_envelope().id().delete(envelope_id);
        }
        deleted += envelope_ids.len();

        let envelopes_remain = ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
            .filter((
                thread_id,
                message.membership_version,
                message.sender_agent_db_id,
                message.secret_version,
            ))
            .next()
            .is_some();
        if !envelopes_remain {
            let coverage_ids: Vec<u64> = ctx
                .db
                .thread_secret_coverage()
                .thread_secret_coverage_tuple()
                .filter((
                    thread_id,
                    message.membership_version,
                    message.sender_agent_db_id,
                    message.secret_version,
                ))
                .map(|coverage| coverage.id)
                .collect();
            for coverage_id in coverage_ids {
                ctx.db.thread_secret_coverage().id().delete(&coverage_id);
            }
        }
    }

    if deleted >= THREAD_SECRET_ENVELOPE_GC_BATCH_SIZE {
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::ThreadSecretEnvelopeGc,
            thread_id,
            timestamp_plus_ms(
                ctx.timestamp,
                THREAD_SECRET_ENVELOPE_GC_RETRY_DELAY_MS as i64,
            ),
        );
    }
}

pub fn schedule_agent_key_bundle_archive(ctx: &ReducerContext, agent_db_id: u64) {
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::AgentKeyBundleArchive,
        agent_db_id,
        ctx.timestamp,
    );
}

pub fn cleanup_agent_key_bundle_archive(ctx: &ReducerContext, agent_db_id: u64) {
    let mut bundles: Vec<AgentKeyBundle> = ctx
        .db
        .agent_key_bundle()
        .agent_key_bundle_agent_db_id()
        .filter(agent_db_id)
        .collect();
    bundles.sort_by(|a, b| b.key_bundle_version.cmp(&a.key_bundle_version));

    let mut deleted = 0usize;
    let mut hit_batch = false;
    for bundle in bundles.into_iter().skip(AGENT_KEY_BUNDLE_RETAIN_RECENT) {
        if deleted >= AGENT_KEY_BUNDLE_ARCHIVE_BATCH_SIZE {
            hit_batch = true;
            break;
        }
        if is_agent_key_bundle_version_referenced(ctx, agent_db_id, bundle.key_bundle_version) {
            continue;
        }
        ctx.db.agent_key_bundle().id().delete(&bundle.id);
        deleted += 1;
    }

    if hit_batch {
        schedule_expiry(
            ctx,
            ScheduledExpiryKind::AgentKeyBundleArchive,
            agent_db_id,
            ctx.timestamp,
        );
    }
}

fn is_agent_key_bundle_version_referenced(
    ctx: &ReducerContext,
    agent_db_id: u64,
    key_bundle_version: u32,
) -> bool {
    ctx.db
        .message()
        .message_sender_agent_db_id_signing_key_version()
        .filter((agent_db_id, key_bundle_version))
        .next()
        .is_some()
        || ctx
            .db
            .channel_message()
            .channel_message_sender_agent_db_id_sender_signing_key_version()
            .filter((agent_db_id, key_bundle_version))
            .next()
            .is_some()
        || ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_sender_agent_db_id_sender_encryption_key_version()
            .filter((agent_db_id, key_bundle_version))
            .next()
            .is_some()
        || ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_sender_agent_db_id_signing_key_version()
            .filter((agent_db_id, key_bundle_version))
            .next()
            .is_some()
        || ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_recipient_agent_db_id_recipient_encryption_key_version()
            .filter((agent_db_id, key_bundle_version))
            .next()
            .is_some()
}

pub fn cleanup_resolved_request_tombstone(ctx: &ReducerContext, target_id: u64) {
    let Some((target, row_id)) = decode_tombstone_target(target_id) else {
        return;
    };
    match target {
        ResolvedRequestTombstoneTarget::ContactRequest => {
            cleanup_contact_request_tombstone(ctx, row_id);
        }
        ResolvedRequestTombstoneTarget::ThreadInvite => {
            cleanup_thread_invite_tombstone(ctx, row_id);
        }
        ResolvedRequestTombstoneTarget::ChannelJoinRequest => {
            cleanup_channel_join_request_tombstone(ctx, row_id);
        }
    }
}

fn cleanup_contact_request_tombstone(ctx: &ReducerContext, request_id: u64) {
    let Some(request) = ctx.db.contact_request().id().find(&request_id) else {
        return;
    };
    let Some(resolved_at) = request.resolved_at else {
        return;
    };
    if matches!(request.status, ContactRequestStatus::Pending)
        || !is_timestamp_expired(
            timestamp_plus_ms(resolved_at, RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS as i64),
            ctx.timestamp,
        )
    {
        return;
    }
    ctx.db.contact_request().id().delete(&request_id);
    bump_contact_requests_signal(ctx, request.requester_account_id);
    bump_contact_requests_signal(ctx, request.target_account_id);
}

fn cleanup_thread_invite_tombstone(ctx: &ReducerContext, invite_id: u64) {
    let Some(invite) = ctx.db.thread_invite().id().find(&invite_id) else {
        return;
    };
    let Some(resolved_at) = invite.resolved_at else {
        return;
    };
    if matches!(invite.status, ThreadInviteStatus::Pending)
        || !is_timestamp_expired(
            timestamp_plus_ms(resolved_at, RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS as i64),
            ctx.timestamp,
        )
    {
        return;
    }
    ctx.db.thread_invite().id().delete(&invite_id);
    bump_thread_invites_signal(ctx, invite.inviter_account_id);
    bump_thread_invites_signal(ctx, invite.invitee_account_id);
}

fn cleanup_channel_join_request_tombstone(ctx: &ReducerContext, request_id: u64) {
    let Some(request) = ctx.db.channel_join_request().id().find(&request_id) else {
        return;
    };
    let Some(resolved_at) = request.resolved_at else {
        return;
    };
    if matches!(request.status, ChannelJoinRequestStatus::Pending)
        || !is_timestamp_expired(
            timestamp_plus_ms(resolved_at, RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS as i64),
            ctx.timestamp,
        )
    {
        return;
    }

    let pending_visibility_ids: Vec<(u64, u64)> = ctx
        .db
        .channel_join_request_admin_visibility()
        .channel_join_request_admin_visibility_request_id()
        .filter(request_id)
        .map(|row| (row.id, row.admin_account_id))
        .collect();
    for (visibility_id, admin_account_id) in pending_visibility_ids {
        ctx.db
            .channel_join_request_admin_visibility()
            .id()
            .delete(&visibility_id);
        bump_channel_join_requests_signal(ctx, admin_account_id);
    }

    let resolved_visibility_ids: Vec<(u64, u64)> = ctx
        .db
        .channel_join_request_resolved_admin_visibility()
        .channel_join_request_resolved_admin_visibility_request_id()
        .filter(request_id)
        .map(|row| (row.id, row.admin_account_id))
        .collect();
    for (visibility_id, admin_account_id) in resolved_visibility_ids {
        ctx.db
            .channel_join_request_resolved_admin_visibility()
            .id()
            .delete(&visibility_id);
        bump_channel_join_requests_signal(ctx, admin_account_id);
    }

    if let Some(fanout) = ctx
        .db
        .channel_join_request_admin_visibility_fanout()
        .request_id()
        .find(&request_id)
    {
        cancel_expiry_for(
            ctx,
            ScheduledExpiryKind::ChannelJoinRequestAdminVisibilityFanout,
            fanout.id,
        );
        ctx.db
            .channel_join_request_admin_visibility_fanout()
            .id()
            .delete(&fanout.id);
    }
    if let Some(fanout) = ctx
        .db
        .channel_join_request_resolved_admin_visibility_fanout()
        .request_id()
        .find(&request_id)
    {
        cancel_expiry_for(
            ctx,
            ScheduledExpiryKind::ChannelJoinRequestResolvedAdminVisibilityFanout,
            fanout.id,
        );
        ctx.db
            .channel_join_request_resolved_admin_visibility_fanout()
            .id()
            .delete(&fanout.id);
    }

    ctx.db.channel_join_request().id().delete(&request_id);
    bump_channel_join_requests_signal(ctx, request.requester_account_id);
}
