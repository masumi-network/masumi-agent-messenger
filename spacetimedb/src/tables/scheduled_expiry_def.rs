//! `scheduled_expiry` — unified scheduled-task table replacing 4 expiry sidecars.
//!
//! Replaces (from old schema):
//! - `device_key_bundle_expiry` → `kind = DeviceKeyBundle`
//! - `inbox_auth_lease_expiry` → `kind = AccountAuthLease`
//! - `rate_limit_cleanup` → `kind = RateLimit`
//! - `rate_limit_report_cleanup` → dropped (table dropped, observability moved to logs)
//!
//! SpacetimeDB scheduled-table: rows fire the `expire_scheduled` reducer at their
//! `scheduled_at` time. The reducer body switches on `kind` and routes to per-kind cleanup
//! logic, then deletes the trigger row. The required `scheduled_id` and `scheduled_at` fields
//! satisfy the SpacetimeDB scheduled-table contract.

use spacetimedb::{ScheduleAt, Timestamp};

use crate::constants::ScheduledExpiryKind;

#[spacetimedb::table(accessor = scheduled_expiry,
    scheduled(crate::operations::system::expire_scheduled::expire_scheduled),
    index(accessor = scheduled_expiry_kind_target_id, btree(columns = [kind, target_id])),
)]
#[derive(Debug, Clone)]
pub struct ScheduledExpiry {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,

    pub scheduled_at: ScheduleAt,

    pub kind: ScheduledExpiryKind,

    /// Per-kind target row id. Interpretation:
    /// - `DeviceShareRequest` → `device_share_request.id`
    /// - `DeviceKeyBundle` → `device_key_bundle.id`
    /// - `AccountAuthLease` → `account_auth_lease.id`
    /// - `RateLimit` → `rate_limit.id`
    /// - `ThreadDeletionCleanup` / `ThreadDeletionCleanupPreserveContactRequests` → `thread.id`
    ///   (per-batch resume token; cleanup runs in bounded batches against this thread)
    /// - `MessageExpiry` → `thread.id` (sweep messages past the thread's retention window)
    /// - `ThreadSecretEnvelopeGc` → `thread.id` (drop envelopes for vacated participants)
    /// - `AgentKeyBundleArchive` → `agent.id` (prune superseded `agent_key_bundle` history)
    /// - `ResolvedRequestTombstone` → composite request id (see `cleanup_resolved_request_tombstone`)
    /// - `ChannelRecencyFanout` → `channel.id` (resume token for batched member fanout)
    /// - `ChannelJoinRequestAdminVisibilityFanout` /
    ///   `ChannelJoinRequestResolvedAdminVisibilityFanout` →
    ///   `channel_join_request.id` (resume token for admin-visibility row materialization)
    pub target_id: u64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
