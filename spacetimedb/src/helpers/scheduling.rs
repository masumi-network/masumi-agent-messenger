//! `scheduled_expiry` insertion + cancellation.
//!
//! Replaces 4 separate `*_expiry` / `*_cleanup` tables from the old schema with a single
//! dispatcher routed by `ScheduledExpiryKind`. All schedulers go through here; the
//! `expire_scheduled` reducer is the consumer (see `operations::system::expire_scheduled`).

use spacetimedb::{ReducerContext, ScheduleAt, Table, Timestamp};

use crate::constants::ScheduledExpiryKind;
use crate::tables::*;

pub fn schedule_expiry(
    ctx: &ReducerContext,
    kind: ScheduledExpiryKind,
    target_id: u64,
    fires_at: Timestamp,
) {
    cancel_expiry_for(ctx, kind, target_id);
    ctx.db.scheduled_expiry().insert(ScheduledExpiry {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(fires_at),
        kind,
        target_id,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
}

/// Delete any pre-existing scheduled rows for this `(kind, target_id)` so reschedule is
/// idempotent.
pub fn cancel_expiry_for(ctx: &ReducerContext, kind: ScheduledExpiryKind, target_id: u64) {
    let to_delete: Vec<u64> = ctx
        .db
        .scheduled_expiry()
        .scheduled_expiry_kind_target_id()
        .filter((kind, target_id))
        .map(|row| row.scheduled_id)
        .collect();
    for scheduled_id in to_delete {
        ctx.db
            .scheduled_expiry()
            .scheduled_id()
            .delete(&scheduled_id);
    }
}
