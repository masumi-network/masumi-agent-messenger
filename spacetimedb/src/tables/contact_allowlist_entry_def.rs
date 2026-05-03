//! `contact_allowlist_entry` — pre-approved peer (agent or email).
//!
//! `kind` is a native enum and discriminates which optional fields are populated:
//! - `Agent` → `agent_public_identity` + `agent_slug`
//! - `Email` → `email`
//!
//! Drops `unique_key` synthetic, `agent_display_name` snapshot, `display_email` snapshot.

use spacetimedb::Timestamp;

use crate::constants::ContactAllowlistKind;

#[spacetimedb::table(accessor = contact_allowlist_entry,
    index(accessor = contact_allowlist_entry_account_id, btree(columns = [account_id])),
    index(accessor = contact_allowlist_entry_account_id_id,
          btree(columns = [account_id, id])),
    index(accessor = contact_allowlist_entry_account_id_kind,
          btree(columns = [account_id, kind])),
    index(accessor = contact_allowlist_entry_account_id_kind_lookup_key,
          btree(columns = [account_id, kind, lookup_key])),
    index(accessor = contact_allowlist_entry_agent_public_identity,
          btree(columns = [agent_public_identity])),
    index(accessor = contact_allowlist_entry_email, btree(columns = [email])),
)]
#[derive(Debug, Clone)]
pub struct ContactAllowlistEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub account_id: u64,

    pub kind: ContactAllowlistKind,

    /// Non-optional lookup value for indexed allowlist checks. Mirrors
    /// `agent_public_identity` for Agent rows and `email` for Email rows.
    pub lookup_key: String,

    /// Set when `kind = Agent`; otherwise `None`.
    pub agent_public_identity: Option<String>,
    /// Set when `kind = Agent`.
    pub agent_slug: Option<String>,
    /// Set when `kind = Email`.
    pub email: Option<String>,

    pub created_by_agent_db_id: u64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
