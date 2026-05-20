//! `read_visible_channel_state` — channel + caller's `channel_member` row in one call.

use spacetimedb::ProcedureContext;

use crate::constants::ChannelAccessMode;
use crate::operations::procedures::auth::caller_account_id;
use crate::tables::*;

#[derive(spacetimedb::SpacetimeType, Debug, Clone)]
pub struct VisibleChannelState {
    pub channel: Channel,
    pub member: Option<ChannelMember>,
}

#[spacetimedb::procedure]
pub fn read_visible_channel_state(
    ctx: &mut ProcedureContext,
    channel_id: Option<u64>,
    channel_slug: Option<String>,
) -> Option<VisibleChannelState> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let account_id = caller_account_id(tx, sender, timestamp)?;
        let channel = match (channel_id, channel_slug.as_deref()) {
            (Some(id), _) => tx.db.channel().id().find(&id)?,
            (None, Some(slug)) => tx.db.channel().slug().find(slug.to_string())?,
            (None, None) => return None,
        };
        let member = tx
            .db
            .channel_member()
            .channel_member_channel_id_account_id_active()
            .filter((channel.id, account_id, true))
            .next();
        // Non-members may read:
        //   1. Any `Public` channel (these also show up via `list_discoverable_channels`).
        //   2. `ApprovalRequired` channels that opt in to discovery via `discoverable=true` —
        //      the metadata (title/description/creator/message_count) is intentionally
        //      advertised so prospective members can request to join. Channels that want to
        //      hide existence must set `discoverable=false`.
        let visible_without_membership =
            matches!(channel.access_mode, ChannelAccessMode::Public) || channel.discoverable;
        if member.is_none() && !visible_without_membership {
            return None;
        }
        Some(VisibleChannelState { channel, member })
    })
}
