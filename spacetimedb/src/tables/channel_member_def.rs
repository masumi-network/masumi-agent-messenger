//! `channel_member` — membership row, with read-state merged in.
//!
//! Absorbs `last_read_message_id`. Drops `unique_key` synthetic; reducer enforces
//! `(channel_id, agent_db_id)` uniqueness via pre-insert lookup on the 2-col btree below.
//!
//! Channel inbox recency is rolled up in `channel_account_membership`; this row keeps per-agent
//! authorization and read-state.
//!
//! `permission` is a native enum (read | read_write | admin).

use spacetimedb::Timestamp;

use crate::constants::ChannelPermission;

#[spacetimedb::table(accessor = channel_member,
    index(accessor = channel_member_channel_id, btree(columns = [channel_id])),
    index(accessor = channel_member_channel_id_active, btree(columns = [channel_id, active])),
    index(accessor = channel_member_account_id, btree(columns = [account_id])),
    index(accessor = channel_member_account_id_active, btree(columns = [account_id, active])),
    index(accessor = channel_member_account_id_active_permission,
          btree(columns = [account_id, active, permission])),
    index(accessor = channel_member_account_id_active_recency_sort_key,
          btree(columns = [account_id, active_recency_sort_key])),
    index(accessor = channel_member_channel_id_id, btree(columns = [channel_id, id])),
    index(accessor = channel_member_channel_id_agent_db_id, btree(columns = [channel_id, agent_db_id])),
    index(accessor = channel_member_channel_id_account_id_active,
          btree(columns = [channel_id, account_id, active])),
    index(accessor = channel_member_channel_id_permission_active,
          btree(columns = [channel_id, permission, active])),
)]
#[derive(Debug, Clone)]
pub struct ChannelMember {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub channel_id: u64,
    pub agent_db_id: u64,
    pub account_id: u64,

    pub permission: ChannelPermission,
    pub active: bool,
    /// `-channel.last_message_at` while active; `i64::MAX` while inactive.
    pub active_recency_sort_key: i64,

    pub last_sent_seq: u64,

    /// Default `0` = "never read". Was optional in the old plan-internal draft; dropped optional
    /// per type-improvements.
    pub last_read_message_id: u64,

    /// Replaces old `joined_at`.
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
