//! Rate-limit bucket increment.
//!
//! Buckets are keyed by `bucket_key` (string built per-action by callers). Window expires at
//! `expires_at`; after expiry, the next call resets the bucket. Violation observability moves
//! to logs (the `rate_limit_report` table is dropped per plan).

use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp, TxContext};

use crate::constants::{RateLimitAction, ScheduledExpiryKind};
use crate::helpers::scheduling::schedule_expiry;
use crate::helpers::time::{is_timestamp_expired, timestamp_plus_ms};
use crate::tables::*;

pub struct EnforceParams<'a> {
    pub bucket_key: &'a str,
    pub action: RateLimitAction,
    pub owner_identity: Identity,
    pub window_ms: i64,
    pub max_count: u64,
}

/// Increments the bucket, returning `true` if the call is allowed and `false` if rate limited.
/// Inserts a new bucket on first hit; resets the bucket on window expiry; bumps `count` or
/// `limited_count` otherwise.
pub fn enforce(ctx: &ReducerContext, params: EnforceParams<'_>) -> bool {
    let now = ctx.timestamp;
    let expires_at = timestamp_plus_ms(now, params.window_ms);
    let table = ctx.db.rate_limit();
    let existing = table.bucket_key().find(params.bucket_key.to_string());

    match existing {
        None => {
            let row = table.insert(RateLimit {
                id: 0,
                bucket_key: params.bucket_key.to_string(),
                action: params.action,
                owner_identity: params.owner_identity,
                window_start: now,
                expires_at,
                count: 1,
                limited_count: 0,
                first_limited_at: None,
                last_limited_at: None,
                created_at: now,
                updated_at: now,
            });
            schedule_expiry(ctx, ScheduledExpiryKind::RateLimit, row.id, expires_at);
            true
        }
        Some(row) if is_timestamp_expired(row.expires_at, now) => {
            let reset = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                window_start: now,
                expires_at,
                count: 1,
                limited_count: 0,
                first_limited_at: None,
                last_limited_at: None,
                updated_at: now,
                ..row
            };
            let updated = table.id().update(reset);
            schedule_expiry(ctx, ScheduledExpiryKind::RateLimit, updated.id, expires_at);
            true
        }
        Some(row) if row.count >= params.max_count => {
            let first_limited_at = row.first_limited_at.or(Some(now));
            let limited = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                limited_count: row.limited_count + 1,
                first_limited_at,
                last_limited_at: Some(now),
                updated_at: now,
                ..row
            };
            table.id().update(limited);
            false
        }
        Some(row) => {
            let bumped = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                count: row.count + 1,
                updated_at: now,
                ..row
            };
            table.id().update(bumped);
            true
        }
    }
}

/// Procedure-flavored variant of [`enforce`]. Procedures expose `tx` (rather than `ctx.db`) for
/// table writes inside `with_tx`; this mirrors the reducer logic but uses `tx.db` and inlines
/// the `scheduled_expiry` insert (the reducer-side `schedule_expiry` helper takes a
/// `&ReducerContext`).
pub fn enforce_in_tx(tx: &TxContext, timestamp: Timestamp, params: EnforceParams<'_>) -> bool {
    let now = timestamp;
    let expires_at = timestamp_plus_ms(now, params.window_ms);
    let table = tx.db.rate_limit();
    let existing = table.bucket_key().find(params.bucket_key.to_string());

    match existing {
        None => {
            let row = table.insert(RateLimit {
                id: 0,
                bucket_key: params.bucket_key.to_string(),
                action: params.action,
                owner_identity: params.owner_identity,
                window_start: now,
                expires_at,
                count: 1,
                limited_count: 0,
                first_limited_at: None,
                last_limited_at: None,
                created_at: now,
                updated_at: now,
            });
            schedule_rate_limit_expiry_in_tx(tx, now, row.id, expires_at);
            true
        }
        Some(row) if is_timestamp_expired(row.expires_at, now) => {
            let reset = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                window_start: now,
                expires_at,
                count: 1,
                limited_count: 0,
                first_limited_at: None,
                last_limited_at: None,
                updated_at: now,
                ..row
            };
            let updated = table.id().update(reset);
            schedule_rate_limit_expiry_in_tx(tx, now, updated.id, expires_at);
            true
        }
        Some(row) if row.count >= params.max_count => {
            let first_limited_at = row.first_limited_at.or(Some(now));
            let limited = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                limited_count: row.limited_count + 1,
                first_limited_at,
                last_limited_at: Some(now),
                updated_at: now,
                ..row
            };
            table.id().update(limited);
            false
        }
        Some(row) => {
            let bumped = RateLimit {
                action: params.action,
                owner_identity: params.owner_identity,
                count: row.count + 1,
                updated_at: now,
                ..row
            };
            table.id().update(bumped);
            true
        }
    }
}

fn schedule_rate_limit_expiry_in_tx(
    tx: &TxContext,
    timestamp: Timestamp,
    target_id: u64,
    fires_at: Timestamp,
) {
    // Cancel any pre-existing scheduled rows so reschedule is idempotent.
    let to_delete: Vec<u64> = tx
        .db
        .scheduled_expiry()
        .scheduled_expiry_kind_target_id()
        .filter((ScheduledExpiryKind::RateLimit, target_id))
        .map(|row| row.scheduled_id)
        .collect();
    for scheduled_id in to_delete {
        tx.db
            .scheduled_expiry()
            .scheduled_id()
            .delete(&scheduled_id);
    }
    tx.db.scheduled_expiry().insert(ScheduledExpiry {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(fires_at),
        kind: ScheduledExpiryKind::RateLimit,
        target_id,
        created_at: timestamp,
        updated_at: timestamp,
    });
}

/// Build the canonical bucket key for an `(action, owner)` pair. Optional `extra` discriminates
/// per-target buckets (e.g. `channel_admin:<sender>:<channel_id>`).
pub fn bucket_key(action: RateLimitAction, owner: Identity, extra: Option<&str>) -> String {
    let action_slug = action_slug(action);
    let owner_hex = owner.to_hex();
    match extra {
        Some(extra) => format!("{action_slug}:{owner_hex}:{extra}"),
        None => format!("{action_slug}:{owner_hex}"),
    }
}

fn action_slug(action: RateLimitAction) -> &'static str {
    match action {
        RateLimitAction::EmailLookup => "email_lookup",
        RateLimitAction::DeviceShareRequest => "device_share_request",
        RateLimitAction::DeviceShareResolve => "device_share_resolve",
        RateLimitAction::PublicChannelLookup => "public_channel_lookup",
        RateLimitAction::PublicAgentLookup => "public_agent_lookup",
        RateLimitAction::PublicKeyLookup => "public_key_lookup",
        RateLimitAction::PublicRouteLookup => "public_route_lookup",
        RateLimitAction::ChannelMessage => "channel_message",
        RateLimitAction::ThreadMessage => "thread_message",
        RateLimitAction::ChannelJoinRequest => "channel_join_request",
        RateLimitAction::ChannelJoin => "channel_join",
        RateLimitAction::ChannelCreate => "channel_create",
        RateLimitAction::ChannelAdmin => "channel_admin",
        RateLimitAction::ThreadAdmin => "thread_admin",
        RateLimitAction::AgentKeyRotate => "agent_key_rotate",
        RateLimitAction::DeviceBundleShare => "device_bundle_share",
        RateLimitAction::ContactRequest => "contact_request",
        RateLimitAction::ContactResolve => "contact_resolve",
    }
}
