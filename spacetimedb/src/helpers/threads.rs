//! Thread participant + invite + direct-pair lookup helpers.
//!
//! Drives the `thread_participant_thread_id_agent_db_id` 2-col index for hot-path lookups, and
//! the participant-fan-out cap (`MAX_THREAD_FANOUT = 50`).

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    ScheduledExpiryKind, ThreadInviteStatus, ThreadKind, MAX_THREAD_FANOUT,
    THREAD_DELETION_CLEANUP_BATCH_SIZE, THREAD_DELETION_CLEANUP_RETRY_DELAY_MS,
};
use crate::helpers::account_signals::{bump_thread_invites_signal, bump_thread_list_signal};
use crate::helpers::scheduling::{cancel_expiry_for, schedule_expiry};
use crate::helpers::time::{
    descending_timestamp_key, timestamp_plus_ms, EXCLUDED_DESCENDING_TIMESTAMP_KEY,
};
use crate::tables::*;

const CLIENT_GENERATED_THREAD_ID_NAMESPACE: u64 = 0x8000_0000_0000_0000;
pub const INACTIVE_THREAD_PARTICIPANT_SORT_KEY: i64 = i64::MAX;
pub const PENDING_THREAD_INVITE_SORT_KEY: i64 = EXCLUDED_DESCENDING_TIMESTAMP_KEY;

pub fn thread_participant_recency_sort_key(
    active: bool,
    updated_at: spacetimedb::Timestamp,
) -> i64 {
    if active {
        descending_timestamp_key(updated_at)
    } else {
        INACTIVE_THREAD_PARTICIPANT_SORT_KEY
    }
}

pub fn is_client_generated_thread_id(thread_id: u64) -> bool {
    (thread_id & CLIENT_GENERATED_THREAD_ID_NAMESPACE) == CLIENT_GENERATED_THREAD_ID_NAMESPACE
}

pub fn get_thread_participant(
    ctx: &ReducerContext,
    thread_id: u64,
    agent_db_id: u64,
) -> Option<ThreadParticipant> {
    ctx.db
        .thread_participant()
        .thread_participant_thread_id_agent_db_id()
        .filter((thread_id, agent_db_id))
        .next()
}

pub fn require_active_thread_participant(
    ctx: &ReducerContext,
    thread_id: u64,
    agent_db_id: u64,
) -> Result<ThreadParticipant, String> {
    let p = get_thread_participant(ctx, thread_id, agent_db_id)
        .ok_or_else(|| "Caller is not a participant of this thread".to_string())?;
    if !p.active {
        return Err("Caller is not an active participant of this thread".to_string());
    }
    Ok(p)
}

pub fn require_admin_thread_participant(
    ctx: &ReducerContext,
    thread_id: u64,
    agent_db_id: u64,
) -> Result<ThreadParticipant, String> {
    let p = require_active_thread_participant(ctx, thread_id, agent_db_id)?;
    if !p.is_admin {
        return Err("Caller is not an admin of this thread".to_string());
    }
    Ok(p)
}

pub fn get_active_thread_participants(
    ctx: &ReducerContext,
    thread_id: u64,
) -> Vec<ThreadParticipant> {
    ctx.db
        .thread_participant()
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .collect()
}

pub fn count_active_thread_participants(ctx: &ReducerContext, thread_id: u64) -> usize {
    ctx.db
        .thread()
        .id()
        .find(&thread_id)
        .map(|thread| thread.active_participant_count as usize)
        .unwrap_or(0)
}

pub fn count_pending_thread_invites(ctx: &ReducerContext, thread_id: u64) -> usize {
    ctx.db
        .thread_invite()
        .thread_invite_thread_id_status()
        .filter((thread_id, ThreadInviteStatus::Pending))
        .count()
}

fn require_fanout_capacity_with_reserved_pending(
    ctx: &ReducerContext,
    thread_id: u64,
    additional: usize,
    reserved_pending: usize,
) -> Result<(), String> {
    let occupied = count_active_thread_participants(ctx, thread_id)
        + count_pending_thread_invites(ctx, thread_id);
    let occupied = occupied.saturating_sub(reserved_pending);
    if occupied + additional > MAX_THREAD_FANOUT {
        return Err(format!(
            "Threads may include at most {MAX_THREAD_FANOUT} active or pending participants"
        ));
    }
    Ok(())
}

pub fn require_fanout_capacity(
    ctx: &ReducerContext,
    thread_id: u64,
    additional: usize,
) -> Result<(), String> {
    require_fanout_capacity_with_reserved_pending(ctx, thread_id, additional, 0)
}

pub fn ensure_thread_participant_reserved(
    ctx: &ReducerContext,
    thread: &Thread,
    agent: &Agent,
    is_admin: bool,
    reserved_pending: usize,
) -> Result<ThreadParticipant, String> {
    ensure_thread_participant_reserved_at_version(
        ctx,
        thread,
        agent,
        is_admin,
        reserved_pending,
        thread.membership_version,
    )
}

pub fn ensure_thread_participant_reserved_at_version(
    ctx: &ReducerContext,
    thread: &Thread,
    agent: &Agent,
    is_admin: bool,
    reserved_pending: usize,
    membership_version: u64,
) -> Result<ThreadParticipant, String> {
    let table = ctx.db.thread_participant();
    if let Some(existing) = get_thread_participant(ctx, thread.id, agent.id) {
        if existing.active {
            return Ok(existing);
        }
        require_fanout_capacity_with_reserved_pending(ctx, thread.id, 1, reserved_pending)?;
        let reactivated = ThreadParticipant {
            active: true,
            is_admin,
            membership_version,
            updated_at: ctx.timestamp,
            active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
            ..existing
        };
        let participant = table.id().update(reactivated);
        increment_active_participant_count(ctx, thread.id);
        bump_thread_list_signal(ctx, agent.account_id);
        return Ok(participant);
    }

    require_fanout_capacity_with_reserved_pending(ctx, thread.id, 1, reserved_pending)?;

    let participant = table.insert(ThreadParticipant {
        id: 0,
        thread_id: thread.id,
        agent_db_id: agent.id,
        account_id: agent.account_id,
        membership_version,
        last_sent_seq: 0,
        last_sent_secret_version: 0,
        last_read_message_id: 0,
        archived: false,
        is_admin,
        active: true,
        active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    increment_active_participant_count(ctx, thread.id);
    bump_thread_list_signal(ctx, agent.account_id);
    Ok(participant)
}

pub fn ensure_thread_participant(
    ctx: &ReducerContext,
    thread: &Thread,
    agent: &Agent,
    is_admin: bool,
) -> Result<ThreadParticipant, String> {
    ensure_thread_participant_reserved(ctx, thread, agent, is_admin, 0)
}

pub fn ensure_thread_invite(
    ctx: &ReducerContext,
    thread_id: u64,
    inviter: &Agent,
    invitee: &Agent,
) -> Result<ThreadInvite, String> {
    if let Some(existing_participant) = get_thread_participant(ctx, thread_id, invitee.id) {
        if existing_participant.active {
            return Err("Agent is already an active participant of this thread".to_string());
        }
    }

    let table = ctx.db.thread_invite();
    let existing = table
        .thread_invite_thread_id_invitee_agent_db_id()
        .filter((thread_id, invitee.id))
        .next();
    if let Some(existing) = existing {
        if matches!(existing.status, ThreadInviteStatus::Pending) {
            return Ok(existing);
        }
        require_fanout_capacity(ctx, thread_id, 1)?;
        let reset = ThreadInvite {
            status: ThreadInviteStatus::Pending,
            inviter_agent_db_id: inviter.id,
            inviter_account_id: inviter.account_id,
            inviter_resolved_sort_key: PENDING_THREAD_INVITE_SORT_KEY,
            invitee_resolved_sort_key: PENDING_THREAD_INVITE_SORT_KEY,
            invitee_pending_sort_key: descending_timestamp_key(ctx.timestamp),
            updated_at: ctx.timestamp,
            resolved_at: None,
            resolved_by_agent_db_id: None,
            ..existing
        };
        let invite = table.id().update(reset);
        bump_thread_invites_signal(ctx, invitee.account_id);
        return Ok(invite);
    }

    require_fanout_capacity(ctx, thread_id, 1)?;

    let invite = table.insert(ThreadInvite {
        id: 0,
        thread_id,
        inviter_agent_db_id: inviter.id,
        inviter_account_id: inviter.account_id,
        invitee_agent_db_id: invitee.id,
        invitee_account_id: invitee.account_id,
        status: ThreadInviteStatus::Pending,
        inviter_resolved_sort_key: PENDING_THREAD_INVITE_SORT_KEY,
        invitee_resolved_sort_key: PENDING_THREAD_INVITE_SORT_KEY,
        invitee_pending_sort_key: descending_timestamp_key(ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        resolved_at: None,
        resolved_by_agent_db_id: None,
    });
    bump_thread_invites_signal(ctx, invitee.account_id);
    Ok(invite)
}

fn increment_active_participant_count(ctx: &ReducerContext, thread_id: u64) {
    let Some(thread) = ctx.db.thread().id().find(&thread_id) else {
        return;
    };
    ctx.db.thread().id().update(Thread {
        active_participant_count: thread.active_participant_count.saturating_add(1),
        updated_at: ctx.timestamp,
        ..thread
    });
}

pub fn decrement_active_participant_count(ctx: &ReducerContext, thread_id: u64) {
    let Some(thread) = ctx.db.thread().id().find(&thread_id) else {
        return;
    };
    ctx.db.thread().id().update(Thread {
        active_participant_count: thread.active_participant_count.saturating_sub(1),
        updated_at: ctx.timestamp,
        ..thread
    });
}

/// Sort a pair of agent db ids so a direct thread's `(low, high)` key is symmetric.
pub fn direct_pair(a: u64, b: u64) -> (u64, u64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Look up the existing direct thread for the sorted `(low, high)` agent pair, if any.
pub fn find_direct_thread(ctx: &ReducerContext, low: u64, high: u64) -> Option<Thread> {
    ctx.db
        .thread()
        .thread_direct_pair()
        .filter((low, high))
        .find(|t| matches!(t.kind, ThreadKind::Direct))
}

fn deactivate_thread_participants(ctx: &ReducerContext, thread_id: u64) {
    let table = ctx.db.thread_participant();
    let participants: Vec<ThreadParticipant> = table
        .thread_participant_thread_id()
        .filter(thread_id)
        .filter(|p| p.active)
        .collect();
    for participant in participants {
        bump_thread_list_signal(ctx, participant.account_id);
        table.id().update(ThreadParticipant {
            active: false,
            active_recency_sort_key: thread_participant_recency_sort_key(false, ctx.timestamp),
            updated_at: ctx.timestamp,
            ..participant
        });
    }
    if let Some(thread) = ctx.db.thread().id().find(&thread_id) {
        ctx.db.thread().id().update(Thread {
            active_participant_count: 0,
            updated_at: ctx.timestamp,
            ..thread
        });
    }
}

fn schedule_thread_deletion(ctx: &ReducerContext, thread_id: u64, preserve_contact_requests: bool) {
    deactivate_thread_participants(ctx, thread_id);
    let kind = if preserve_contact_requests {
        ScheduledExpiryKind::ThreadDeletionCleanupPreserveContactRequests
    } else {
        ScheduledExpiryKind::ThreadDeletionCleanup
    };
    let other_kind = if preserve_contact_requests {
        ScheduledExpiryKind::ThreadDeletionCleanup
    } else {
        ScheduledExpiryKind::ThreadDeletionCleanupPreserveContactRequests
    };
    cancel_expiry_for(ctx, other_kind, thread_id);
    schedule_expiry(ctx, kind, thread_id, ctx.timestamp);
}

pub fn delete_thread_and_dependents(ctx: &ReducerContext, thread_id: u64) {
    schedule_thread_deletion(ctx, thread_id, false);
}

pub fn delete_thread_and_dependents_preserving_contact_requests(
    ctx: &ReducerContext,
    thread_id: u64,
) {
    schedule_thread_deletion(ctx, thread_id, true);
}

fn delete_message_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .message()
        .message_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|m| m.id)
        .collect();
    for id in &ids {
        ctx.db.message().id().delete(id);
    }
    ids.len()
}

fn delete_envelope_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .thread_secret_envelope()
        .thread_secret_envelope_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|e| e.id)
        .collect();
    for id in &ids {
        ctx.db.thread_secret_envelope().id().delete(id);
    }
    ids.len()
}

fn delete_secret_coverage_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .thread_secret_coverage()
        .thread_secret_coverage_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|c| c.id)
        .collect();
    for id in &ids {
        ctx.db.thread_secret_coverage().id().delete(id);
    }
    ids.len()
}

fn delete_invite_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .thread_invite()
        .thread_invite_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|i| i.id)
        .collect();
    for id in &ids {
        ctx.db.thread_invite().id().delete(id);
    }
    ids.len()
}

fn delete_participant_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .thread_participant()
        .thread_participant_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|p| p.id)
        .collect();
    for id in &ids {
        ctx.db.thread_participant().id().delete(id);
    }
    ids.len()
}

fn delete_contact_request_batch(ctx: &ReducerContext, thread_id: u64, cap: usize) -> usize {
    let ids: Vec<u64> = ctx
        .db
        .contact_request()
        .contact_request_thread_id()
        .filter(thread_id)
        .take(cap)
        .map(|r| r.id)
        .collect();
    for id in &ids {
        ctx.db.contact_request().id().delete(id);
    }
    ids.len()
}

fn thread_deletion_has_dependents(
    ctx: &ReducerContext,
    thread_id: u64,
    preserve_contact_requests: bool,
) -> bool {
    ctx.db
        .message()
        .message_thread_id()
        .filter(thread_id)
        .next()
        .is_some()
        || ctx
            .db
            .thread_secret_envelope()
            .thread_secret_envelope_thread_id()
            .filter(thread_id)
            .next()
            .is_some()
        || ctx
            .db
            .thread_secret_coverage()
            .thread_secret_coverage_thread_id()
            .filter(thread_id)
            .next()
            .is_some()
        || ctx
            .db
            .thread_invite()
            .thread_invite_thread_id()
            .filter(thread_id)
            .next()
            .is_some()
        || ctx
            .db
            .thread_participant()
            .thread_participant_thread_id()
            .filter(thread_id)
            .next()
            .is_some()
        || (!preserve_contact_requests
            && ctx
                .db
                .contact_request()
                .contact_request_thread_id()
                .filter(thread_id)
                .next()
                .is_some())
}

pub fn cleanup_thread_deletion_batch(
    ctx: &ReducerContext,
    thread_id: u64,
    preserve_contact_requests: bool,
) {
    let cap = THREAD_DELETION_CLEANUP_BATCH_SIZE;
    delete_message_batch(ctx, thread_id, cap);
    delete_envelope_batch(ctx, thread_id, cap);
    delete_secret_coverage_batch(ctx, thread_id, cap);
    delete_invite_batch(ctx, thread_id, cap);
    delete_participant_batch(ctx, thread_id, cap);
    if !preserve_contact_requests {
        delete_contact_request_batch(ctx, thread_id, cap);
    }

    if thread_deletion_has_dependents(ctx, thread_id, preserve_contact_requests) {
        let kind = if preserve_contact_requests {
            ScheduledExpiryKind::ThreadDeletionCleanupPreserveContactRequests
        } else {
            ScheduledExpiryKind::ThreadDeletionCleanup
        };
        schedule_expiry(
            ctx,
            kind,
            thread_id,
            timestamp_plus_ms(ctx.timestamp, THREAD_DELETION_CLEANUP_RETRY_DELAY_MS as i64),
        );
        return;
    }

    if ctx.db.thread().id().find(&thread_id).is_some() {
        ctx.db.thread().id().delete(thread_id);
    }
}

pub fn promote_replacement_admin(ctx: &ReducerContext, thread_id: u64) {
    if ctx
        .db
        .thread_participant()
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .any(|p| p.is_admin)
    {
        return;
    }
    let candidate = ctx
        .db
        .thread_participant()
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .min_by_key(|p| p.id);
    if let Some(c) = candidate {
        let promoted = ThreadParticipant {
            is_admin: true,
            updated_at: ctx.timestamp,
            active_recency_sort_key: thread_participant_recency_sort_key(true, ctx.timestamp),
            ..c
        };
        ctx.db.thread_participant().id().update(promoted);
    }
}

pub fn require_another_active_thread_admin(
    ctx: &ReducerContext,
    thread_id: u64,
    excluded_agent_db_id: u64,
) -> Result<(), String> {
    let has_other_admin = ctx
        .db
        .thread_participant()
        .thread_participant_thread_id_active()
        .filter((thread_id, true))
        .any(|p| p.agent_db_id != excluded_agent_db_id && p.is_admin);
    if has_other_admin {
        Ok(())
    } else {
        Err("Cannot demote the last active thread admin".to_string())
    }
}
