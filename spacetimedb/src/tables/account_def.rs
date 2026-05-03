//! `account` — OIDC-authenticated user account.
//!
//! Renamed from `inbox` to disambiguate from the product/UX term "inbox" (threads/messages view).
//! 1:N to `agent` — one OIDC user can publish multiple agent personas under one account.

use spacetimedb::{Identity, Timestamp};

#[spacetimedb::table(accessor = account)]
#[derive(Debug, Clone)]
pub struct Account {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub owner_identity: Identity,

    /// Normalized at write time (lowercased + trimmed by `helpers::validate::normalize_email`).
    /// Single column — no separate `display_email`. Original casing is intentionally not
    /// preserved; the OIDC `email` claim is normalized once on extraction in `helpers::oidc`.
    #[unique]
    pub email: String,

    /// `<issuer>|<subject>` joined identity key, unique per OIDC provider account.
    #[unique]
    pub auth_identity_key: String,

    pub auth_subject: String,

    pub auth_issuer: String,

    pub auth_verified_at: Timestamp,

    pub auth_expires_at: Timestamp,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
