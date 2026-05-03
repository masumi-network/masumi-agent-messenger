//! `channel_account_membership` — account-level channel inbox row.
//!
//! `channel_member` remains the per-agent authorization/read-state row. This rollup keeps one
//! active recency row per `(channel_id, account_id)` so an account with thousands of agents in a
//! channel does not scan or duplicate all of its agent memberships when listing channels.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_account_membership,
    index(accessor = channel_account_membership_account_id_active_recency_sort_key,
          btree(columns = [account_id, active_recency_sort_key])),
    index(accessor = channel_account_membership_account_id_active_recency_sort_key_id,
          btree(columns = [account_id, active_recency_sort_key, id])),
    index(accessor = channel_account_membership_account_id_active_admin_count,
          btree(columns = [account_id, active_admin_count])),
    index(accessor = channel_account_membership_channel_id_id,
          btree(columns = [channel_id, id])),
    index(accessor = channel_account_membership_channel_id_account_id,
          btree(columns = [channel_id, account_id])),
)]
#[derive(Debug, Clone)]
pub struct ChannelAccountMembership {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub channel_id: u64,
    pub account_id: u64,

    pub active_agent_count: u64,
    pub active_admin_count: u64,
    pub active_recency_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
