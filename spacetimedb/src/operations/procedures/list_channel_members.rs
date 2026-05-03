//! `list_channel_members` — paginate members of a channel by insertion-order id.
//! Cursor: `after_id?`. Auth-gated: caller must be an active member.

use spacetimedb::ProcedureContext;

use crate::constants::MAX_CHANNEL_MEMBER_PAGE_SIZE;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn list_channel_members(
    ctx: &mut ProcedureContext,
    channel_id: u64,
    after_id: Option<u64>,
    limit: Option<u32>,
) -> Vec<ChannelMember> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Some(account_id) = caller_account_id(tx, sender, timestamp) else {
            return Vec::new();
        };
        let is_member = tx
            .db
            .channel_member()
            .channel_member_channel_id_account_id_active()
            .filter((channel_id, account_id, true))
            .next()
            .is_some();
        if !is_member {
            return Vec::new();
        }

        let cap = limit
            .unwrap_or(MAX_CHANNEL_MEMBER_PAGE_SIZE)
            .min(MAX_CHANNEL_MEMBER_PAGE_SIZE) as usize;
        let start_id = after_id.unwrap_or(0).saturating_add(1);
        tx.db
            .channel_member()
            .channel_member_channel_id_id()
            .filter((channel_id, start_id..))
            .take(cap)
            .collect()
    })
}
