//! `channel_join_request_admin_visibility_fanout` — scheduled pending-visibility cursor.
//!
//! A new join request no longer inserts one row per admin inside the caller reducer. This table
//! lets `expire_scheduled` materialize the direct pending index in bounded batches.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_join_request_admin_visibility_fanout)]
#[derive(Debug, Clone)]
pub struct ChannelJoinRequestAdminVisibilityFanout {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub request_id: u64,

    pub channel_id: u64,
    pub next_account_membership_id: u64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
