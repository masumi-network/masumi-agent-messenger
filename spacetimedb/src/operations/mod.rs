//! Reducers, views, and procedures grouped by domain — one file per item.
//!
//! Per the plan: ~32 reducers, ~15 views, ~23 procedures. Each lives in `<domain>/<item>.rs`.
//! `client_connected` lifecycle hook lives at the crate root (added in the identity reducer step).
//!
//! Domains:
//! - `identity` — accounts, agents, devices, key bundles, OIDC lease lifecycle, Masumi registration
//! - `threads` — direct + group threads, participants, encrypted messages, secret envelopes, invites
//! - `channels` — public/private channels, members, plaintext signed messages, join requests
//! - `contacts` — contact requests + allowlist
//! - `system` — `expire_scheduled` dispatcher, rate-limit cleanup
//!
//! Submodules added as items land in subsequent implementation steps.

pub mod channels;
pub mod contacts;
pub mod identity;
pub mod procedures;
pub mod system;
pub mod threads;
pub mod views;
