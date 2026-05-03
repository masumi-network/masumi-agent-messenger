//! `channel_join_request` — pending channel join request.
//!
//! Distinct workflow from `thread_invite` (per user decision — kept separate). Join requests
//! are pulled (you ask to join); invites are pushed (someone invites you). The status enum
//! reflects request semantics: `pending | approved | rejected`.
//!
//! Admin side filters `(channel_id, status='pending')` via the 2-col index below; admin
//! precondition (caller is admin in the channel) uses `channel_member`'s
//! `(channel_id, permission, active)` 3-col index. Drops `unique_key` synthetic.
//!
//! `permission` and `status` are native enums.

use spacetimedb::Timestamp;

use crate::constants::{ChannelJoinRequestStatus, ChannelPermission};

#[spacetimedb::table(accessor = channel_join_request,
    index(accessor = channel_join_request_channel_id_status, btree(columns = [channel_id, status])),
    index(accessor = channel_join_request_channel_id_status_updated_at,
          btree(columns = [channel_id, status, updated_at])),
    index(accessor = channel_join_request_channel_id_resolved_sort_key,
          btree(columns = [channel_id, channel_resolved_sort_key])),
    index(accessor = channel_join_request_channel_id_resolved_sort_key_id,
          btree(columns = [channel_id, channel_resolved_sort_key, id])),
    index(accessor = channel_join_request_channel_id_pending_sort_key,
          btree(columns = [channel_id, channel_pending_sort_key])),
    index(accessor = channel_join_request_channel_id_pending_sort_key_id,
          btree(columns = [channel_id, channel_pending_sort_key, id])),
    index(accessor = channel_join_request_channel_id_requester_agent_db_id_status,
          btree(columns = [channel_id, requester_agent_db_id, status])),
    index(accessor = channel_join_request_requester_account_id_status,
          btree(columns = [requester_account_id, status])),
    index(accessor = channel_join_request_requester_account_id_status_updated_at,
          btree(columns = [requester_account_id, status, updated_at])),
    index(accessor = channel_join_request_requester_account_id_resolved_sort_key,
          btree(columns = [requester_account_id, requester_resolved_sort_key])),
    index(accessor = channel_join_request_requester_account_id_resolved_sort_key_id,
          btree(columns = [requester_account_id, requester_resolved_sort_key, id])),
    index(accessor = channel_join_request_requester_account_id_pending_sort_key,
          btree(columns = [requester_account_id, requester_pending_sort_key])),
    index(accessor = channel_join_request_requester_account_id_pending_sort_key_id,
          btree(columns = [requester_account_id, requester_pending_sort_key, id])),
)]
#[derive(Debug, Clone)]
pub struct ChannelJoinRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub channel_id: u64,

    pub requester_agent_db_id: u64,
    pub requester_account_id: u64,

    pub permission: ChannelPermission,
    pub status: ChannelJoinRequestStatus,
    /// `-updated_at` once resolved; `i64::MAX` while pending.
    pub channel_resolved_sort_key: i64,
    /// `-updated_at` once resolved; `i64::MAX` while pending.
    pub requester_resolved_sort_key: i64,
    /// `-updated_at` while pending/visible to channel admins; `i64::MAX` once resolved.
    pub channel_pending_sort_key: i64,
    /// `-updated_at` while pending/visible to requester; `i64::MAX` once resolved.
    pub requester_pending_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,

    pub resolved_at: Option<Timestamp>,
    pub resolved_by_agent_db_id: Option<u64>,
}
