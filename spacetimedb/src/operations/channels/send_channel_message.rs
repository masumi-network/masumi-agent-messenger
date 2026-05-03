//! `send_channel_message` — append a signed plaintext message to a channel.
//!
//! The sender membership and sender account channel row are updated synchronously. Other active
//! account recency rows are refreshed by scheduled bounded batches so large channels do not make
//! this reducer walk every member in one transaction.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    RateLimitAction, CHANNEL_MESSAGE_RATE_MAX_PER_WINDOW, CHANNEL_MESSAGE_RATE_WINDOW_MS,
    MAX_CHANNEL_PLAINTEXT_CHARS, SIGNATURE_BYTES,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::agents::get_owned_actor;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::channels::{
    bump_channel_account_recency, channel_member_recency_sort_key,
    public_discoverable_channel_id_desc_sort_key, public_discoverable_channel_page_sort_key,
    public_discoverable_channel_sort_key, require_send_permission, schedule_channel_recency_fanout,
};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::validate::{ensure_exact_byte_len, require_non_empty};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn send_channel_message(
    ctx: &ReducerContext,
    agent_db_id: u64,
    channel_id: u64,
    sender_message_id: u64,
    sender_signing_key_version: u32,
    plaintext: String,
    signature: Vec<u8>,
    reply_to_message_id: Option<u64>,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;
    let actor = get_owned_actor(ctx, agent_db_id, account.id)?;
    let member = require_send_permission(ctx, channel_id, actor.id)?;

    let bk = bucket_key(
        RateLimitAction::ChannelMessage,
        ctx.sender(),
        Some(&channel_id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::ChannelMessage,
            owner_identity: ctx.sender(),
            window_ms: CHANNEL_MESSAGE_RATE_WINDOW_MS as i64,
            max_count: CHANNEL_MESSAGE_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Channel message rate limit exceeded; try again later".to_string());
    }

    let normalized_plaintext = require_non_empty(&plaintext, "plaintext")?;
    if normalized_plaintext.chars().count() > MAX_CHANNEL_PLAINTEXT_CHARS {
        return Err(format!(
            "plaintext must be {MAX_CHANNEL_PLAINTEXT_CHARS} characters or fewer"
        ));
    }
    ensure_exact_byte_len(&signature, SIGNATURE_BYTES, "signature")?;
    if sender_signing_key_version != actor.current_key_bundle_version {
        return Err(
            "senderSigningKeyVersion must match the sender's current signing key version"
                .to_string(),
        );
    }
    if sender_message_id == 0 {
        return Err("senderMessageId must be > 0".to_string());
    }

    let dup = ctx
        .db
        .channel_message()
        .channel_message_sender_agent_db_id_sender_message_id()
        .filter((actor.id, sender_message_id))
        .next()
        .is_some();
    if dup {
        return Err("senderMessageId has already been used by this sender".to_string());
    }

    if let Some(reply_id) = reply_to_message_id {
        let replied = ctx
            .db
            .channel_message()
            .id()
            .find(&reply_id)
            .ok_or_else(|| "replyToMessageId not found".to_string())?;
        if replied.channel_id != channel_id {
            return Err("replyToMessageId is not in this channel".to_string());
        }
    }

    let channel = ctx
        .db
        .channel()
        .id()
        .find(&channel_id)
        .ok_or_else(|| "Channel not found".to_string())?;
    let next_sender_seq = member.last_sent_seq.saturating_add(1);
    let inserted = ctx.db.channel_message().insert(ChannelMessage {
        id: 0,
        channel_id,
        id_desc_sort_key: u64::MAX,
        sender_agent_db_id: actor.id,
        sender_public_identity: actor.public_identity.clone(),
        sender_signing_key_version,
        sender_message_id,
        plaintext: normalized_plaintext,
        signature,
        reply_to_message_id,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    let message = ctx.db.channel_message().id().update(ChannelMessage {
        id_desc_sort_key: u64::MAX.saturating_sub(inserted.id),
        ..inserted
    });

    let updated_channel = Channel {
        last_message_id: message.id,
        message_count: channel.message_count.saturating_add(1),
        last_message_at: ctx.timestamp,
        public_discoverable_sort_key: public_discoverable_channel_sort_key(
            channel.access_mode,
            channel.discoverable,
            ctx.timestamp,
        ),
        public_discoverable_id_desc_sort_key: public_discoverable_channel_id_desc_sort_key(
            channel.access_mode,
            channel.discoverable,
            channel.id,
        ),
        public_discoverable_page_sort_key: public_discoverable_channel_page_sort_key(
            channel.access_mode,
            channel.discoverable,
            ctx.timestamp,
            channel.id,
        ),
        updated_at: ctx.timestamp,
        ..channel
    };
    ctx.db.channel().id().update(updated_channel);

    let updated_member = ChannelMember {
        last_sent_seq: next_sender_seq,
        last_read_message_id: message.id.max(member.last_read_message_id),
        active_recency_sort_key: channel_member_recency_sort_key(true, ctx.timestamp),
        updated_at: ctx.timestamp,
        ..member
    };
    ctx.db.channel_member().id().update(updated_member);
    bump_channel_account_recency(ctx, channel_id, actor.account_id, ctx.timestamp);
    schedule_channel_recency_fanout(ctx, channel_id, ctx.timestamp);
    Ok(())
}
