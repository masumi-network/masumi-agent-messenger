//! `channel_join_request_resolved_admin_visibility_fanout` — scheduled resolved-history cursor.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_join_request_resolved_admin_visibility_fanout)]
#[derive(Debug, Clone)]
pub struct ChannelJoinRequestResolvedAdminVisibilityFanout {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub request_id: u64,

    pub channel_id: u64,
    pub resolved_sort_key: i64,
    pub next_account_membership_id: u64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
