//! `channel_recency_fanout` — scheduled cursor for large channel recency updates.
//!
//! Channel messages update the channel row and sender account membership synchronously, then
//! schedule bounded batches to refresh the remaining active account recency keys. This keeps
//! `send_channel_message` from walking a 10k-member channel inside the caller reducer.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = channel_recency_fanout)]
#[derive(Debug, Clone)]
pub struct ChannelRecencyFanout {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub channel_id: u64,

    pub target_recency_sort_key: i64,
    pub next_account_membership_id: u64,
    pub restart_requested: bool,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
