//! `contact_request` — pending direct-message contact request, gating hidden messages.
//!
//! Identity-pinning snapshots (`requester_public_identity`, `requester_slug`,
//! `target_public_identity`, `target_slug`) are kept on the row so the recipient sees a
//! trust-stable view even if the peer rotates keys before approval. Display-name and email
//! snapshots are dropped (look up live at view time — drift acceptable for display).
//!
//! `status` is a native enum.

use spacetimedb::Timestamp;

use crate::constants::ContactRequestStatus;

#[spacetimedb::table(accessor = contact_request,
    index(accessor = contact_request_thread_id, btree(columns = [thread_id])),
    index(accessor = contact_request_requester_account_id_status,
          btree(columns = [requester_account_id, status])),
    index(accessor = contact_request_requester_account_id_status_updated_at,
          btree(columns = [requester_account_id, status, updated_at])),
    index(accessor = contact_request_requester_account_id_resolved_sort_key,
          btree(columns = [requester_account_id, requester_resolved_sort_key])),
    index(accessor = contact_request_requester_account_id_resolved_sort_key_id,
          btree(columns = [requester_account_id, requester_resolved_sort_key, id])),
    index(accessor = contact_request_requester_account_id_pending_sort_key,
          btree(columns = [requester_account_id, requester_pending_sort_key])),
    index(accessor = contact_request_requester_account_id_pending_sort_key_id,
          btree(columns = [requester_account_id, requester_pending_sort_key, id])),
    index(accessor = contact_request_target_account_id_status,
          btree(columns = [target_account_id, status])),
    index(accessor = contact_request_target_account_id_status_updated_at,
          btree(columns = [target_account_id, status, updated_at])),
    index(accessor = contact_request_target_account_id_resolved_sort_key,
          btree(columns = [target_account_id, target_resolved_sort_key])),
    index(accessor = contact_request_target_account_id_resolved_sort_key_id,
          btree(columns = [target_account_id, target_resolved_sort_key, id])),
    index(accessor = contact_request_target_account_id_pending_sort_key,
          btree(columns = [target_account_id, target_pending_sort_key])),
    index(accessor = contact_request_target_account_id_pending_sort_key_id,
          btree(columns = [target_account_id, target_pending_sort_key, id])),
    index(accessor = contact_request_requester_agent_db_id_status,
          btree(columns = [requester_agent_db_id, status])),
    index(accessor = contact_request_requester_agent_db_id_target_agent_db_id_status,
          btree(columns = [requester_agent_db_id, target_agent_db_id, status])),
    index(accessor = contact_request_requester_agent_db_id_status_updated_at,
          btree(columns = [requester_agent_db_id, status, updated_at])),
    index(accessor = contact_request_requester_agent_db_id_resolved_sort_key,
          btree(columns = [requester_agent_db_id, requester_resolved_sort_key])),
    index(accessor = contact_request_target_agent_db_id_status,
          btree(columns = [target_agent_db_id, status])),
    index(accessor = contact_request_target_agent_db_id_requester_agent_db_id_status,
          btree(columns = [target_agent_db_id, requester_agent_db_id, status])),
    index(accessor = contact_request_target_agent_db_id_status_updated_at,
          btree(columns = [target_agent_db_id, status, updated_at])),
    index(accessor = contact_request_target_agent_db_id_resolved_sort_key,
          btree(columns = [target_agent_db_id, target_resolved_sort_key])),
)]
#[derive(Debug, Clone)]
pub struct ContactRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,

    pub requester_agent_db_id: u64,
    pub target_agent_db_id: u64,
    pub requester_account_id: u64,
    pub target_account_id: u64,

    pub requester_public_identity: String,
    pub requester_slug: String,
    pub target_public_identity: String,
    pub target_slug: String,

    pub status: ContactRequestStatus,
    /// `-updated_at` once visible in requester history; `i64::MAX` while pending/hidden.
    pub requester_resolved_sort_key: i64,
    /// `-updated_at` once visible in target history; `i64::MAX` while pending.
    pub target_resolved_sort_key: i64,
    /// `-created_at` while pending/visible to requester; `i64::MAX` once hidden/resolved.
    pub requester_pending_sort_key: i64,
    /// `-created_at` while pending/visible to target; `i64::MAX` once resolved.
    pub target_pending_sort_key: i64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,

    pub resolved_at: Option<Timestamp>,
    pub resolved_by_agent_db_id: Option<u64>,

    /// Requester-side tombstone for rejected requests the sender has dismissed.
    pub requester_hidden_at: Option<Timestamp>,
}
