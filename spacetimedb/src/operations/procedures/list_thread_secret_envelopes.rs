//! `list_thread_secret_envelopes` — fetch envelopes for a thread when the client detects a
//! rotation marker (`message.attaches_new_envelopes = true`) or needs to verify rotation
//! state before sending. Auth-gated.
//!
//! Optional filters narrow to a specific (membership_version, secret_version) tuple or to the
//! caller as recipient. The result is always bounded by `limit` (clamped to
//! `MAX_THREAD_SECRET_ENVELOPE_PAGE_SIZE`); pass `after_id` to page through older entries.

use spacetimedb::ProcedureContext;

use crate::constants::MAX_THREAD_SECRET_ENVELOPE_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn list_thread_secret_envelopes(
    ctx: &mut ProcedureContext,
    agent_db_id: u64,
    thread_id: u64,
    membership_version: Option<u64>,
    sender_agent_db_id: Option<u64>,
    recipient_agent_db_id: Option<u64>,
    secret_version: Option<u32>,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<ThreadSecretEnvelope> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    let cap = limit
        .unwrap_or(MAX_THREAD_SECRET_ENVELOPE_PAGE_SIZE)
        .min(MAX_THREAD_SECRET_ENVELOPE_PAGE_SIZE) as usize;
    let cursor = after_id.unwrap_or(0);
    let start_id = cursor.saturating_add(1);
    ctx.with_tx(|tx| {
        if cap == 0 {
            return Vec::new();
        }
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let Some(actor) = tx.db.agent().id().find(&agent_db_id) else {
            return Vec::new();
        };
        if actor.account_id != account_id {
            return Vec::new();
        }
        let Some(caller_participant) = tx
            .db
            .thread_participant()
            .thread_participant_thread_id_agent_db_id()
            .filter((thread_id, agent_db_id))
            .next()
        else {
            return Vec::new();
        };
        if !caller_participant.active {
            return Vec::new();
        }
        let visible_from_membership_version = caller_participant.membership_version;
        let Some(_thread) = tx.db.thread().id().find(thread_id) else {
            return Vec::new();
        };

        let matches_filters = |env: &ThreadSecretEnvelope| -> bool {
            if env.membership_version < visible_from_membership_version {
                return false;
            }
            if env.sender_agent_db_id != agent_db_id && env.recipient_agent_db_id != agent_db_id {
                return false;
            }
            if let Some(s) = sender_agent_db_id {
                if env.sender_agent_db_id != s {
                    return false;
                }
            }
            if let Some(r) = recipient_agent_db_id {
                if env.recipient_agent_db_id != r {
                    return false;
                }
            }
            if let Some(v) = secret_version {
                if env.secret_version != v {
                    return false;
                }
            }
            true
        };

        let mut rows: Vec<ThreadSecretEnvelope> = if let Some(mv) = membership_version {
            if mv < visible_from_membership_version {
                return Vec::new();
            }
            if let (Some(s), Some(v)) = (sender_agent_db_id, secret_version) {
                tx.db
                    .thread_secret_envelope()
                    .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version_id()
                    .filter((thread_id, mv, s, v, start_id..))
                    .filter(matches_filters)
                    .take(cap)
                    .collect()
            } else {
                tx.db
                    .thread_secret_envelope()
                    .thread_secret_envelope_thread_id_membership_version_id()
                    .filter((thread_id, mv, start_id..))
                    .filter(matches_filters)
                    .take(cap)
                    .collect()
            }
        } else if let (Some(recipient), Some(v)) = (recipient_agent_db_id, secret_version) {
            tx.db
                .thread_secret_envelope()
                .thread_secret_envelope_thread_id_recipient_agent_db_id_secret_version_id()
                .filter((thread_id, recipient, v, start_id..))
                .filter(matches_filters)
                .take(cap)
                .collect()
        } else {
            // Take cap+1 per arm so a fresh page that happens to span the sender/recipient split
            // still sees enough rows after de-dupe to fill `cap` and signal `has_more` via the
            // outer truncate. Bounded scan: at most 2*(cap+1) rows touched per call.
            let per_arm_take = cap.saturating_add(1);
            let mut by_id: std::collections::BTreeMap<u64, ThreadSecretEnvelope> =
                std::collections::BTreeMap::new();
            for env in tx
                .db
                .thread_secret_envelope()
                .thread_secret_envelope_thread_id_sender_agent_db_id_id()
                .filter((thread_id, agent_db_id, start_id..))
                .filter(matches_filters)
                .take(per_arm_take)
            {
                by_id.insert(env.id, env);
            }
            for env in tx
                .db
                .thread_secret_envelope()
                .thread_secret_envelope_thread_id_recipient_agent_db_id_id()
                .filter((thread_id, agent_db_id, start_id..))
                .filter(matches_filters)
                .take(per_arm_take)
            {
                by_id.insert(env.id, env);
            }
            by_id.into_values().collect()
        };

        rows.sort_by_key(|env| env.id);
        rows.truncate(cap);
        rows
    })
}
