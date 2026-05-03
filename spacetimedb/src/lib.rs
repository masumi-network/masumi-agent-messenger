//! Masumi agent-to-agent encrypted inbox — SpacetimeDB module (Rust).
//!
//! Source-of-truth schema and reducers per `/Users/sandro/.claude/plans/ok-i-want-to-glittery-blanket.md`.
//!
//! Architectural rules (from `spacetimedb/AGENTS.md`):
//! - Reducers are deterministic and do not return data.
//! - Use `ctx.sender` as the trusted identity.
//! - The server never holds private keys, never decrypts ciphertext, never derives thread secrets.
//! - Channels are signed plaintext; threads are end-to-end encrypted.
//! - Per-peer key trust is a client responsibility — the server is not a trust anchor for rotated peer keys.
//!
//! Layout (one file per item — table / reducer / view / procedure):
//! - `tables/` — 20 table definitions, one per file.
//! - `helpers/` — shared utilities (auth lease, scheduling, OIDC, fan-out, row transforms).
//! - `operations/<domain>/` — reducers, views, procedures grouped by domain (identity / threads /
//!   channels / contacts / system), one item per file.

#![allow(clippy::too_many_arguments)]

pub mod constants;
pub mod generated_oidc_config;
pub mod helpers;
pub mod operations;
pub mod tables;
