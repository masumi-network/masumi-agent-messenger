//! `update_channel_member_read_state` — caller advances their own
//! `last_read_message_id` on a channel they're an active member of.
//!
//! **Caller-only — does NOT fan out** (channels never fan out membership writes per the
//! rework plan; see `channel_member_def.rs`). Bumping is monotonic via `.max()`.

use spacetimedb::ReducerContext;

use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::require_active_channel_member;
use crate::helpers::oidc::require_oidc_claims;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn update_channel_member_read_state(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    last_read_message_id: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;

    if ctx.db.channel().id().find(&channel_id).is_none() {
        return Err("Channel not found".to_string());
    }
    let member = require_active_channel_member(ctx, channel_id, actor.id)?;
    if last_read_message_id > 0 {
        let Some(message) = ctx.db.channel_message().id().find(&last_read_message_id) else {
            return Err("lastReadMessageId message not found".to_string());
        };
        if message.channel_id != channel_id {
            return Err("lastReadMessageId is not in this channel".to_string());
        }
    }

    let new_last_read = last_read_message_id.max(member.last_read_message_id);
    if new_last_read == member.last_read_message_id {
        return Ok(());
    }

    let updated = ChannelMember {
        last_read_message_id: new_last_read,
        updated_at: ctx.timestamp,
        ..member
    };
    ctx.db.channel_member().id().update(updated);

    Ok(())
}
