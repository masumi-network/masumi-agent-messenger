//! `create_thread` — entrypoint for opening empty Direct threads and Group threads.
//!
//! Contact-gated first messages are intentionally handled only by `request_direct_contact` so
//! rate limits, thread-id collision checks, envelope validation, and contact-request insertion
//! have one owner.
//!
//! - **Direct, contact allowed**: empty thread + both seated. Auto thread id.
//! - **Direct, contact NOT allowed**: error — use `request_direct_contact`.
//! - **Group**: auto thread id, auto-add or invite per contact.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{ThreadKind, MAX_THREAD_FANOUT};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::{get_owned_actor, get_required_agent_by_public_identity};
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::contacts::is_direct_contact_allowed;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::threads::{direct_pair, ensure_thread_invite, ensure_thread_participant};
use crate::helpers::validate::normalize_optional;
use crate::tables::*;

const MAX_THREAD_TITLE_CHARS: usize = 200;

#[spacetimedb::reducer]
pub fn create_thread(
    ctx: &ReducerContext,
    agent_db_id: u64,
    kind: ThreadKind,
    other_agent_public_identity: Option<String>,
    participant_public_identities: Option<Vec<String>>,
    title: Option<String>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    let normalized_title = normalize_optional(title.as_deref(), MAX_THREAD_TITLE_CHARS, "title")?;

    match kind {
        ThreadKind::Direct => {
            let other = other_agent_public_identity
                .ok_or_else(|| "Direct threads require otherAgentPublicIdentity".to_string())?;
            let other_actor = get_required_agent_by_public_identity(ctx, &other)?;
            if other_actor.id == actor.id {
                return Err("Direct threads require a second actor".to_string());
            }
            let (low, high) = direct_pair(actor.id, other_actor.id);
            if !is_direct_contact_allowed(ctx, &actor, &other_actor) {
                return Err(
                    "Direct contact requires approval. Use request_direct_contact with a first encrypted message."
                        .to_string(),
                );
            }

            let thread = ctx.db.thread().insert(Thread {
                id: 0,
                kind: ThreadKind::Direct,
                direct_low_agent_db_id: low,
                direct_high_agent_db_id: high,
                title: normalized_title,
                creator_agent_db_id: actor.id,
                membership_version: 1,
                active_participant_count: 0,
                last_message_id: 0,
                message_count: 0,
                last_message_at: ctx.timestamp,
                message_retention_ms: None,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
            ensure_thread_participant(ctx, &thread, &actor, true)?;
            ensure_thread_participant(ctx, &thread, &other_actor, true)?;
        }
        ThreadKind::Group => {
            let mut idents = participant_public_identities
                .ok_or_else(|| "Group threads require participantPublicIdentities".to_string())?;
            idents.push(actor.public_identity.clone());
            idents.sort();
            idents.dedup();
            if idents.len() < 2 {
                return Err(
                    "Group threads require at least one participant besides the creator"
                        .to_string(),
                );
            }
            if idents.len() > MAX_THREAD_FANOUT {
                return Err(format!(
                    "Threads may include at most {MAX_THREAD_FANOUT} active or pending participants"
                ));
            }

            let mut participants: Vec<Agent> = Vec::with_capacity(idents.len());
            for ident in &idents {
                participants.push(get_required_agent_by_public_identity(ctx, ident)?);
            }

            let thread = ctx.db.thread().insert(Thread {
                id: 0,
                kind: ThreadKind::Group,
                direct_low_agent_db_id: 0,
                direct_high_agent_db_id: 0,
                title: normalized_title,
                creator_agent_db_id: actor.id,
                membership_version: 1,
                active_participant_count: 0,
                last_message_id: 0,
                message_count: 0,
                last_message_at: ctx.timestamp,
                message_retention_ms: None,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });

            for participant in participants {
                if participant.id == actor.id {
                    ensure_thread_participant(ctx, &thread, &participant, true)?;
                } else if is_direct_contact_allowed(ctx, &actor, &participant) {
                    ensure_thread_participant(ctx, &thread, &participant, false)?;
                } else {
                    ensure_thread_invite(ctx, thread.id, &actor, &participant)?;
                }
            }
        }
    }

    Ok(())
}
