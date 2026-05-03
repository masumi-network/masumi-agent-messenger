//! Live-subscribable views (auth-gated by `account_auth_lease`).
//!
//! Each view first resolves the caller's active lease; if missing or inactive, the view returns
//! an empty vec (caller is treated as unauthenticated). Live views carry metadata/read-model
//! signals; message bodies are intentionally read through paginated procedures.

pub mod visible_account_change_signal;
pub mod visible_accounts;
pub mod visible_channel_memberships;
pub mod visible_channels;
pub mod visible_device_key_bundles;
pub mod visible_device_share_requests;

mod auth;
