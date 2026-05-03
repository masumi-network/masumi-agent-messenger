//! `channel_join_request_resolved_admin_visibility` — per-admin-account resolved history rows.
//!
//! Resolved join-request history needs to page directly by admin account. The request row remains
//! canonical; this sidecar only stores the visibility key needed for bounded history reads.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_join_request_resolved_admin_visibility,
    index(accessor = channel_join_request_resolved_admin_visibility_admin_account_id_resolved_sort_key,
          btree(columns = [admin_account_id, resolved_sort_key])),
    index(accessor = channel_join_request_resolved_admin_visibility_admin_account_id_resolved_sort_key_request_id,
          btree(columns = [admin_account_id, resolved_sort_key, request_id])),
    index(accessor = channel_join_request_resolved_admin_visibility_request_id,
          btree(columns = [request_id])),
    index(accessor = channel_join_request_resolved_admin_visibility_request_id_admin_account_id,
          btree(columns = [request_id, admin_account_id])),
    index(accessor = channel_join_request_resolved_admin_visibility_channel_id_admin_account_id,
          btree(columns = [channel_id, admin_account_id])),
)]
#[derive(Debug, Clone)]
pub struct ChannelJoinRequestResolvedAdminVisibility {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub request_id: u64,
    pub channel_id: u64,
    pub admin_account_id: u64,
    pub resolved_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
