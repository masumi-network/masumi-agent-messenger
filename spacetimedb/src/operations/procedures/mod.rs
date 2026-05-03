//! Procedures (request/response, paginated reads).
//!
//! **Status**: enabled via the `unstable` Cargo feature. Procedures in SDK 2.1 are gated by the
//! `unstable` flag because the macro surface may shift in 2.2; we accept that churn risk in
//! exchange for not having to fall back to reducer + scratch-table workarounds.
//!
//! Procedures listed below; see plan for parameter shapes and pagination semantics:
//!
//! Cross-account public reads (anonymous-callable):
//! - `lookup_published_agent_by_slug`
//! - `lookup_published_agents_by_email_page` (`after_id?`)
//! - `lookup_published_public_route_by_slug`
//! - `lookup_agent_public_keys`
//! - `lookup_published_agent_signing_keys`
//! - `list_public_channel_messages` (gated on `channel.access_mode = Public`)
//! - `lookup_public_channel_by_slug`
//! - `lookup_agent_key_bundles`
//!
//! Authenticated paginated reads:
//! - `list_thread_messages` (`before_message_id?`)
//! - `list_channel_messages` (`before_message_id?`)
//! - `list_channel_members` (`after_id?`)
//! - `list_thread_participants` (`after_id?`)
//! - `list_owned_agents_page` (`after_id?`)
//! - `list_owned_devices` (`after_id?`)
//! - `list_contact_allowlist_entries` (`after_id?`)
//! - `list_visible_threads` (`after_sort_key?`)
//! - `list_visible_channel_page` (`after_sort_key?`)
//! - `list_pending_contact_requests_page` (`after_sort_key?`)
//! - `list_pending_thread_invites_page` (`after_sort_key?`)
//! - `list_pending_channel_join_requests_page` (`after_sort_key?`)
//! - `list_discoverable_channels` (`before_last_message_at?`, `before_channel_id?`)
//! - `read_visible_thread`
//! - `read_visible_channel_state`
//! - `read_owned_agent`
//! - `read_contact_request`
//! - `list_thread_secret_envelopes`
//!
//! Resolved-history companions to status-filtered views:
//! - `list_resolved_thread_invites`
//! - `list_resolved_contact_requests`
//! - `list_resolved_channel_join_requests`
//!
//! Reducer-equivalent reads that must return data:
//! - `claim_device_key_bundle`
//! - `resolve_device_share_request_by_code`
//!
//! Pagination cursor patterns are documented in the plan ("Pagination cursor patterns").

pub mod auth;
pub mod claim_device_key_bundle;
pub mod list_channel_members;
pub mod list_channel_messages;
pub mod list_contact_allowlist_entries;
pub mod list_discoverable_channels;
pub mod list_owned_agents_page;
pub mod list_owned_devices;
pub mod list_pending_channel_join_requests_page;
pub mod list_pending_contact_requests_page;
pub mod list_pending_thread_invites_page;
pub mod list_public_channel_messages;
pub mod list_resolved_channel_join_requests;
pub mod list_resolved_contact_requests;
pub mod list_resolved_thread_invites;
pub mod list_thread_messages;
pub mod list_thread_participants;
pub mod list_thread_secret_envelopes;
pub mod list_visible_channel_page;
pub mod list_visible_threads;
pub mod lookup_agent_key_bundles;
pub mod lookup_agent_public_keys;
pub mod lookup_public_channel_by_slug;
pub mod lookup_published_agent_by_slug;
pub mod lookup_published_agent_signing_keys;
pub mod lookup_published_agents_by_email;
pub mod lookup_published_public_route_by_slug;
pub mod read_contact_request;
pub mod read_owned_agent;
pub mod read_visible_channel_state;
pub mod read_visible_thread;
pub mod resolve_device_share_request_by_code;
pub mod types;
