//! `list_thread_messages` — paginated message bodies for a visible thread. Auth-gated: caller
//! must be an active participant in the thread. Cursor: `before_message_id?`. Also returns the
//! secret envelopes referenced by the page so the client can decrypt without a follow-up call.

use std::ops::Bound;

use spacetimedb::{ProcedureContext, TxContext};

use crate::constants::MAX_THREAD_MESSAGE_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct ListThreadMessagesPage {
    pub messages: Vec<Message>,
    pub secret_envelopes: Vec<ThreadSecretEnvelope>,
    pub next_before_message_id: Option<u64>,
}

fn empty_page() -> ListThreadMessagesPage {
    ListThreadMessagesPage {
        messages: Vec::new(),
        secret_envelopes: Vec::new(),
        next_before_message_id: None,
    }
}

fn list_thread_message_window(
    tx: &TxContext,
    thread: &Thread,
    before_message_id: Option<u64>,
    cap: usize,
    visible_from_membership_version: u64,
) -> (Vec<Message>, Option<u64>) {
    if cap == 0 {
        return (Vec::new(), None);
    }

    if matches!(before_message_id, Some(0)) {
        return (Vec::new(), None);
    }

    let has_visible_messages = tx
        .db
        .message()
        .message_thread_id_membership_version_id_desc_sort_key()
        .filter((thread.id, visible_from_membership_version..))
        .next()
        .is_some();
    if !has_visible_messages {
        return (Vec::new(), None);
    }

    let target_len = cap.saturating_add(1);
    let cursor = before_message_id.map(|id| u64::MAX.saturating_sub(id));
    let mut messages: Vec<Message> = if let Some(cursor) = cursor {
        tx.db
            .message()
            .message_thread_id_id_desc_sort_key()
            .filter((thread.id, (Bound::Excluded(cursor), Bound::Unbounded)))
            .take(target_len)
            .collect()
    } else {
        tx.db
            .message()
            .message_thread_id_id_desc_sort_key()
            .filter((thread.id, 0u64..u64::MAX))
            .take(target_len)
            .collect()
    };
    messages.retain(|m| m.membership_version >= visible_from_membership_version);

    let has_more = messages.len() > cap;
    messages.truncate(cap);
    let next_before_message_id = if has_more {
        messages.last().map(|m| m.id)
    } else {
        None
    };
    (messages, next_before_message_id)
}

#[spacetimedb::procedure]
pub fn list_thread_messages(
    ctx: &mut ProcedureContext,
    agent_db_id: u64,
    thread_id: u64,
    before_message_id: Option<u64>,
    limit: Option<u32>,
) -> ListThreadMessagesPage {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return empty_page();
        };
        let Some(actor) = tx.db.agent().id().find(&agent_db_id) else {
            return empty_page();
        };
        if actor.account_id != account_id {
            return empty_page();
        }
        // Caller must be the selected active agent participant in the thread.
        // Visibility starts at the participant row's current membership version; a reactivated
        // agent does not regain messages from a previous membership window.
        let Some(caller_participant) = tx
            .db
            .thread_participant()
            .thread_participant_thread_id_agent_db_id()
            .filter((thread_id, agent_db_id))
            .next()
        else {
            return empty_page();
        };
        if !caller_participant.active {
            return empty_page();
        }
        let visible_from_membership_version = caller_participant.membership_version;

        let Some(thread) = tx.db.thread().id().find(&thread_id) else {
            return empty_page();
        };

        let cap = limit
            .unwrap_or(MAX_THREAD_MESSAGE_PAGE_SIZE)
            .min(MAX_THREAD_MESSAGE_PAGE_SIZE) as usize;
        let (messages, next_before_message_id) = list_thread_message_window(
            tx,
            &thread,
            before_message_id,
            cap,
            visible_from_membership_version,
        );

        // Pull only the sender-specific secret envelopes referenced by the message page.
        let referenced: std::collections::BTreeSet<(u64, u64, u32)> = messages
            .iter()
            .map(|m| {
                (
                    m.membership_version,
                    m.sender_agent_db_id,
                    m.secret_version,
                )
            })
            .collect();
        let mut secret_envelopes: Vec<ThreadSecretEnvelope> = Vec::new();
        for (membership_version, sender_agent_db_id, secret_version) in referenced {
            secret_envelopes.extend(
                tx.db
                    .thread_secret_envelope()
                    .thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version()
                    .filter((thread_id, membership_version, sender_agent_db_id, secret_version))
                    .filter(|env| {
                        env.sender_agent_db_id == agent_db_id
                            || env.recipient_agent_db_id == agent_db_id
                    }),
            );
        }

        ListThreadMessagesPage {
            messages,
            secret_envelopes,
            next_before_message_id,
        }
    })
}
