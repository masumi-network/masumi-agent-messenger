//! `expire_scheduled` — single dispatcher reducer for the unified `scheduled_expiry` table.
//!
//! Replaces 4 separate `*_expiry` / `*_cleanup` reducers from the old schema. Switches on
//! `row.kind` and routes to per-kind cleanup logic, then deletes the trigger row.
//!
//! SpacetimeDB scheduled-table contract: this function is invoked by the runtime for each
//! `scheduled_expiry` row at its `scheduled_at` time. Caller is the module identity, not a
//! user. Use `helpers::oidc::require_scheduled_call` to gate spoofed client invocations.

use spacetimedb::ReducerContext;

use crate::constants::ScheduledExpiryKind;
use crate::helpers::channels::{
    cleanup_channel_join_request_admin_visibility_fanout_batch,
    cleanup_channel_join_request_resolved_admin_visibility_fanout_batch,
    cleanup_channel_recency_fanout_batch,
};
use crate::helpers::oidc::require_scheduled_call;
use crate::helpers::retention::{
    cleanup_agent_key_bundle_archive, cleanup_message_expiry_batch,
    cleanup_resolved_request_tombstone, cleanup_thread_secret_envelope_gc_batch,
};
use crate::helpers::threads::cleanup_thread_deletion_batch;
use crate::helpers::time::{is_timestamp_expired, EXCLUDED_DESCENDING_TIMESTAMP_KEY};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn expire_scheduled(ctx: &ReducerContext, row: ScheduledExpiry) -> Result<(), String> {
    require_scheduled_call(ctx)?;

    match row.kind {
        ScheduledExpiryKind::DeviceShareRequest => {
            if let Some(request) = ctx.db.device_share_request().id().find(&row.target_id) {
                if request.consumed_at.is_none()
                    && is_timestamp_expired(request.expires_at, ctx.timestamp)
                {
                    let updated = DeviceShareRequest {
                        consumed_at: Some(ctx.timestamp),
                        pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
                        updated_at: ctx.timestamp,
                        ..request
                    };
                    ctx.db.device_share_request().id().update(updated);
                }
            }
        }
        ScheduledExpiryKind::DeviceKeyBundle => {
            if let Some(bundle) = ctx.db.device_key_bundle().id().find(&row.target_id) {
                if is_timestamp_expired(bundle.expires_at, ctx.timestamp) {
                    ctx.db.device_key_bundle().id().delete(&row.target_id);
                }
            }
        }
        ScheduledExpiryKind::AccountAuthLease => {
            if let Some(lease) = ctx.db.account_auth_lease().id().find(&row.target_id) {
                if lease.active && is_timestamp_expired(lease.expires_at, ctx.timestamp) {
                    let updated = AccountAuthLease {
                        active: false,
                        updated_at: ctx.timestamp,
                        ..lease
                    };
                    ctx.db.account_auth_lease().id().update(updated);
                }
            }
        }
        ScheduledExpiryKind::RateLimit => {
            if let Some(bucket) = ctx.db.rate_limit().id().find(&row.target_id) {
                if is_timestamp_expired(bucket.expires_at, ctx.timestamp) {
                    ctx.db.rate_limit().id().delete(&row.target_id);
                }
            }
        }
        ScheduledExpiryKind::ThreadDeletionCleanup => {
            cleanup_thread_deletion_batch(ctx, row.target_id, false);
        }
        ScheduledExpiryKind::ThreadDeletionCleanupPreserveContactRequests => {
            cleanup_thread_deletion_batch(ctx, row.target_id, true);
        }
        ScheduledExpiryKind::MessageExpiry => {
            cleanup_message_expiry_batch(ctx, row.target_id);
        }
        ScheduledExpiryKind::ThreadSecretEnvelopeGc => {
            cleanup_thread_secret_envelope_gc_batch(ctx, row.target_id);
        }
        ScheduledExpiryKind::AgentKeyBundleArchive => {
            cleanup_agent_key_bundle_archive(ctx, row.target_id);
        }
        ScheduledExpiryKind::ResolvedRequestTombstone => {
            cleanup_resolved_request_tombstone(ctx, row.target_id);
        }
        ScheduledExpiryKind::ChannelRecencyFanout => {
            cleanup_channel_recency_fanout_batch(ctx, row.target_id);
        }
        ScheduledExpiryKind::ChannelJoinRequestAdminVisibilityFanout => {
            cleanup_channel_join_request_admin_visibility_fanout_batch(ctx, row.target_id);
        }
        ScheduledExpiryKind::ChannelJoinRequestResolvedAdminVisibilityFanout => {
            cleanup_channel_join_request_resolved_admin_visibility_fanout_batch(ctx, row.target_id);
        }
    }

    ctx.db
        .scheduled_expiry()
        .scheduled_id()
        .delete(&row.scheduled_id);
    Ok(())
}
