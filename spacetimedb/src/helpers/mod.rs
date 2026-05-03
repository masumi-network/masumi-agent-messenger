//! Shared utilities used by reducers, views, and procedures.
//!
//! Submodules (one per concern):
//! - `time` — Timestamp math (ms/micros conversion, expiry check)
//! - `slug` — inbox/agent slug normalization (FNV64 hash, reserved-slug check)
//! - `validate` — string normalization + length / hex / email validation
//! - `oidc` — JWT claim extraction + identity-key construction
//! - `auth_lease` — server-side OIDC lease lifecycle
//! - `scheduling` — `scheduled_expiry` insertion + cancellation
//! - `rate_limit` — bucket increment + window expiry
//! - `thread_fanout` — bump `updated_at` across all active participants of a thread

pub mod account_signals;
pub mod accounts;
pub mod agents;
pub mod auth_lease;
pub mod channels;
pub mod contacts;
pub mod devices;
pub mod envelopes;
pub mod messages;
pub mod oidc;
pub mod rate_limit;
pub mod retention;
pub mod scheduling;
pub mod slug;
pub mod thread_fanout;
pub mod threads;
pub mod time;
pub mod validate;
