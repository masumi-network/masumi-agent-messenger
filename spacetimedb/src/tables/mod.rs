//! All module tables — one file per table.
//!
//! Per the rework plan (30 → 20 tables). Mirror tables, expiry sidecars, and read-state sidecars
//! are dropped. See plan section "New Schema (20 tables)".
//!
//! Conventions:
//! - Every row carries `created_at` and `updated_at: Timestamp`. Append-only rows set
//!   `updated_at == created_at` at insert; the column is kept for uniform tooling and audit.
//! - Identity-side foreign keys use `account_id` (renamed from `inbox_id`). Agent-side FKs
//!   use `agent_db_id` to disambiguate from the public `publicIdentity` string.
//! - No synthetic compound-uniqueness columns (`uniqueKey`, `*SeqKey`). Reducers enforce
//!   uniqueness via indexed lookup pre-insert.
//! - No legacy default sentinels (`senderMessageId=1n`, `sortKey='pending'`, `LEGACY` keys).
//! - String columns that were really enums (`status`, `mode`, `kind`, `permission`, `algorithm`)
//!   are promoted to native Rust enums in `crate::constants`.
//! - String columns that were really monotonic counters (`*KeyVersion`, `secretVersion`) are
//!   promoted to `u32`.
//!
//! Module file naming: each table lives in `<name>_def.rs` (the `_def` suffix avoids the
//! macro-generated table-accessor trait colliding with the module name when star-re-exported).
//! Star-export brings in both the row struct (e.g. `AccountAuthLease`) and the accessor trait
//! (e.g. `account_auth_lease`) so a single `use crate::tables::*;` makes both available.

mod account_auth_lease_def;
mod account_change_signal_def;
mod account_def;
mod agent_def;
mod agent_key_bundle_def;
mod channel_account_membership_def;
mod channel_def;
mod channel_join_request_admin_visibility_def;
mod channel_join_request_admin_visibility_fanout_def;
mod channel_join_request_def;
mod channel_join_request_resolved_admin_visibility_def;
mod channel_join_request_resolved_admin_visibility_fanout_def;
mod channel_member_def;
mod channel_message_def;
mod channel_recency_fanout_def;
mod contact_allowlist_entry_def;
mod contact_request_def;
mod device_def;
mod device_key_bundle_def;
mod device_share_request_def;
mod message_def;
mod rate_limit_def;
mod scheduled_expiry_def;
mod thread_def;
mod thread_invite_def;
mod thread_participant_def;
mod thread_secret_coverage_def;
mod thread_secret_envelope_def;

pub use account_auth_lease_def::*;
pub use account_change_signal_def::*;
pub use account_def::*;
pub use agent_def::*;
pub use agent_key_bundle_def::*;
pub use channel_account_membership_def::*;
pub use channel_def::*;
pub use channel_join_request_admin_visibility_def::*;
pub use channel_join_request_admin_visibility_fanout_def::*;
pub use channel_join_request_def::*;
pub use channel_join_request_resolved_admin_visibility_def::*;
pub use channel_join_request_resolved_admin_visibility_fanout_def::*;
pub use channel_member_def::*;
pub use channel_message_def::*;
pub use channel_recency_fanout_def::*;
pub use contact_allowlist_entry_def::*;
pub use contact_request_def::*;
pub use device_def::*;
pub use device_key_bundle_def::*;
pub use device_share_request_def::*;
pub use message_def::*;
pub use rate_limit_def::*;
pub use scheduled_expiry_def::*;
pub use thread_def::*;
pub use thread_invite_def::*;
pub use thread_participant_def::*;
pub use thread_secret_coverage_def::*;
pub use thread_secret_envelope_def::*;
