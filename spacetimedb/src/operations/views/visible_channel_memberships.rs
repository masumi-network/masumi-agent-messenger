//! Caller's own channel memberships only. Full per-channel member list via
//! `list_channel_members(channel_id, after_id?)` procedure.

use spacetimedb::ViewContext;

use crate::constants::MAX_VISIBLE_CHANNEL_PAGE_SIZE;
use crate::helpers::channels::INACTIVE_CHANNEL_MEMBER_SORT_KEY;
use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_channel_memberships, public)]
pub fn visible_channel_memberships(ctx: &ViewContext) -> Vec<ChannelMember> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    ctx.db
        .channel_member()
        .channel_member_account_id_active_recency_sort_key()
        .filter((account_id, ..INACTIVE_CHANNEL_MEMBER_SORT_KEY))
        .take(MAX_VISIBLE_CHANNEL_PAGE_SIZE as usize)
        .collect()
}
