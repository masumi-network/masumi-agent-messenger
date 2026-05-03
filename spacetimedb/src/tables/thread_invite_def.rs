//! `thread_invite` — pending thread invitation.
//!
//! Distinct workflow from `channel_join_request` (per user decision — kept separate). Invites
//! are pushed (someone invites you); join requests are pulled (you ask to join). The status
//! enum reflects the invite semantics: `pending | accepted | declined` (was `rejected` in old
//! schema; renamed for natural reading on an invite).
//!
//! Drops `unique_key` synthetic.

use spacetimedb::Timestamp;

use crate::constants::ThreadInviteStatus;

#[spacetimedb::table(accessor = thread_invite,
    index(accessor = thread_invite_thread_id, btree(columns = [thread_id])),
    index(accessor = thread_invite_thread_id_status, btree(columns = [thread_id, status])),
    index(accessor = thread_invite_thread_id_invitee_agent_db_id,
          btree(columns = [thread_id, invitee_agent_db_id])),
    index(accessor = thread_invite_invitee_account_id_status,
          btree(columns = [invitee_account_id, status])),
    index(accessor = thread_invite_invitee_account_id_pending_sort_key,
          btree(columns = [invitee_account_id, invitee_pending_sort_key])),
    index(accessor = thread_invite_invitee_account_id_pending_sort_key_id,
          btree(columns = [invitee_account_id, invitee_pending_sort_key, id])),
    index(accessor = thread_invite_inviter_account_id_resolved_sort_key,
          btree(columns = [inviter_account_id, inviter_resolved_sort_key])),
    index(accessor = thread_invite_inviter_account_id_resolved_sort_key_id,
          btree(columns = [inviter_account_id, inviter_resolved_sort_key, id])),
    index(accessor = thread_invite_inviter_agent_db_id, btree(columns = [inviter_agent_db_id])),
    index(accessor = thread_invite_inviter_agent_db_id_status_updated_at,
          btree(columns = [inviter_agent_db_id, status, updated_at])),
    index(accessor = thread_invite_invitee_account_id_status_updated_at,
          btree(columns = [invitee_account_id, status, updated_at])),
    index(accessor = thread_invite_inviter_agent_db_id_resolved_sort_key,
          btree(columns = [inviter_agent_db_id, inviter_resolved_sort_key])),
    index(accessor = thread_invite_invitee_account_id_resolved_sort_key,
          btree(columns = [invitee_account_id, invitee_resolved_sort_key])),
    index(accessor = thread_invite_invitee_account_id_resolved_sort_key_id,
          btree(columns = [invitee_account_id, invitee_resolved_sort_key, id])),
)]
#[derive(Debug, Clone)]
pub struct ThreadInvite {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,

    pub inviter_agent_db_id: u64,
    pub inviter_account_id: u64,
    pub invitee_agent_db_id: u64,
    pub invitee_account_id: u64,

    pub status: ThreadInviteStatus,
    /// `-updated_at` once resolved; `i64::MAX` while pending.
    pub inviter_resolved_sort_key: i64,
    /// `-updated_at` once resolved; `i64::MAX` while pending.
    pub invitee_resolved_sort_key: i64,
    /// `-updated_at` while pending/visible to invitee; `i64::MAX` once resolved.
    pub invitee_pending_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,

    pub resolved_at: Option<Timestamp>,
    pub resolved_by_agent_db_id: Option<u64>,
}
