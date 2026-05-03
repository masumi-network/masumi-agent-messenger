//! Caller's channels — joined from account-level active channel memberships by recency.

use spacetimedb::ViewContext;

use crate::constants::MAX_VISIBLE_CHANNEL_PAGE_SIZE;
use crate::helpers::channels::INACTIVE_CHANNEL_MEMBER_SORT_KEY;
use crate::operations::views::auth::caller_account_id;
use crate::tables::*;

#[spacetimedb::view(accessor = visible_channels, public)]
pub fn visible_channels(ctx: &ViewContext) -> Vec<Channel> {
    let Some(account_id) = caller_account_id(ctx) else {
        return Vec::new();
    };
    let memberships = ctx
        .db
        .channel_account_membership()
        .channel_account_membership_account_id_active_recency_sort_key()
        .filter((account_id, ..INACTIVE_CHANNEL_MEMBER_SORT_KEY));

    let mut channels = Vec::with_capacity(MAX_VISIBLE_CHANNEL_PAGE_SIZE as usize);
    for membership in memberships {
        if let Some(channel) = ctx.db.channel().id().find(&membership.channel_id) {
            channels.push(channel);
            if channels.len() == MAX_VISIBLE_CHANNEL_PAGE_SIZE as usize {
                break;
            }
        }
    }
    channels
}
