//! `account_change_signal` — one lightweight row per account for procedure snapshot invalidation.
//!
//! Procedure-backed reads are not live subscriptions, so clients subscribe to the auth-gated
//! `visible_account_change_signal` view and use these monotonic versions as refresh keys.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = account_change_signal,
    index(accessor = account_change_signal_account_id, btree(columns = [account_id])),
)]
#[derive(Debug, Clone)]
pub struct AccountChangeSignal {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub account_id: u64,

    pub owned_agents_version: u64,
    pub owned_devices_version: u64,
    pub contact_requests_version: u64,
    pub thread_invites_version: u64,
    pub contact_allowlist_version: u64,
    pub channel_join_requests_version: u64,
    pub thread_list_version: u64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
