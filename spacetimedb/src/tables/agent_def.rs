//! `agent` — published persona under an account.
//!
//! 1:N from `account` — one OIDC user can publish multiple agents (different slugs, different
//! keys, different profiles). Masumi network registration is held inline in the optional
//! `masumi_*` fields below; presence of `masumi_registration_state` signals a known registration
//! lifecycle state, and `None` is "never registered". Registration is per-agent and rare, so a
//! sidecar table is not warranted. The registration network/id/state tuple invariant is enforced
//! inside `upsert_masumi_registration`; `masumi_agent_identifier` may be absent while pending.
//!
//! Key material lives in `agent_key_bundle`; this row carries only the current bundle pointer.
//! Clients resolve material via the bundle.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = agent,
    index(accessor = agent_account_id, btree(columns = [account_id])),
    index(accessor = agent_account_id_is_default, btree(columns = [account_id, is_default])),
    index(accessor = agent_account_id_id, btree(columns = [account_id, id])),
    index(accessor = agent_email, btree(columns = [email])),
    index(accessor = agent_email_public_linked_enabled,
          btree(columns = [email, public_linked_email_enabled])),
    index(accessor = agent_email_public_linked_enabled_id,
          btree(columns = [email, public_linked_email_enabled, id])),
)]
#[derive(Debug, Clone)]
pub struct Agent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub account_id: u64,

    /// Human-routable public slug.
    #[unique]
    pub slug: String,

    /// Stable public identity exposed to clients. It is slug-backed in this fresh schema, but kept
    /// explicit because messages, contact requests, allowlist entries, and peer trust pin this
    /// identity string.
    #[unique]
    pub public_identity: String,

    /// Denormalized from `account.email`. Account email is OIDC-pinned and
    /// effectively immutable, so no sync churn.
    pub email: String,

    pub display_name: Option<String>,
    pub public_description: Option<String>,

    pub is_default: bool,
    pub public_linked_email_enabled: bool,

    /// Default `true`. Was optional in the old schema; dropped optional per type-improvements.
    pub allow_all_message_content_types: bool,
    /// Default `true`. Was optional in the old schema; dropped optional per type-improvements.
    pub allow_all_message_headers: bool,

    /// Default `[]`. Was optional in the old schema; empty array carries the same meaning.
    pub supported_message_content_types: Vec<String>,
    /// Default `[]`. Same as above.
    pub supported_message_header_names: Vec<String>,

    pub masumi_registration_network: Option<String>,
    pub masumi_inbox_agent_id: Option<String>,
    pub masumi_agent_identifier: Option<String>,
    pub masumi_registration_state: Option<crate::constants::MasumiRegistrationState>,

    pub current_key_bundle_version: u32,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
