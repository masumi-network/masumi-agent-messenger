//! `channel` — signed-plaintext channel container.
//!
//! Per `CLAUDE.md`: channels are intentionally **signed plaintext shared feeds**, NOT end-to-
//! end-private threads. Trust on channel signers is enforced device-side, not via per-peer
//! pinning (see channel exception in CLAUDE.md).
//!
//! **Not** `public: true` — anonymous channel browsing is dropped per user decision. Anonymous
//! viewers reach a public channel only via direct slug link and read history through the
//! `listPublicChannelMessages` procedure (request/response, not a live subscription).
//!
//! Drops: `last_message_seq` / `next_channel_seq` (message history uses auto-increment
//! `channel_message.id` cursors), `public_join_permission` (derive from `access_mode`),
//! `discoverable_sort_key='pending'` legacy.
//!
//! `access_mode` is a native enum.

use spacetimedb::Timestamp;

use crate::constants::{ChannelAccessMode, ChannelPermission};

#[spacetimedb::table(accessor = channel,
    index(accessor = channel_public_discoverable_sort_key,
          btree(columns = [public_discoverable_sort_key])),
    index(accessor = channel_public_discoverable_page_sort_key,
          btree(columns = [public_discoverable_page_sort_key])),
)]
#[derive(Debug, Clone)]
pub struct Channel {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub slug: String,

    pub title: Option<String>,
    pub description: Option<String>,

    pub access_mode: ChannelAccessMode,
    pub discoverable: bool,
    /// `-last_message_at` for public discoverable channels; `i64::MAX` otherwise. This lets
    /// discovery page newest-first with a forward btree scan.
    pub public_discoverable_sort_key: i64,
    /// `u64::MAX - id` for public discoverable channels; `u64::MAX` otherwise. This is the
    /// stable newest-first tiebreaker for channels with identical `last_message_at` values.
    pub public_discoverable_id_desc_sort_key: u64,
    /// Fixed-width composite key of `(public_discoverable_sort_key, id desc)` for indexed
    /// discovery pagination with a stable id tiebreaker.
    pub public_discoverable_page_sort_key: String,

    /// Permission seated for `join_public_channel` auto-joiners and the default suggestion for
    /// `request_channel_join`. A joiner who wants a different permission must go through the
    /// approval flow (admin chooses on `approve_channel_join`). Cannot be `Admin`.
    pub default_permission: ChannelPermission,

    pub creator_agent_db_id: u64,

    /// Single per-channel timeline. This is projected onto active account-level channel recency
    /// rows by scheduled bounded fan-out after a channel message.
    /// Latest auto-increment `channel_message.id`, or `0` before the first message.
    pub last_message_id: u64,
    /// Display-only count of channel messages. Message ordering and cursors use
    /// auto-increment `channel_message.id`.
    pub message_count: u64,

    pub last_message_at: Timestamp,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
