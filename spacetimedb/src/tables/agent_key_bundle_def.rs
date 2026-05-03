//! `agent_key_bundle` — append-only coupled encryption/signing key history per agent.
//!
//! Enables clients to verify historical channel-message signatures against the signing key
//! version that signed them, even after rotation. Per the channel-trust exception in
//! `CLAUDE.md`, channel signers do not require per-peer pinning — clients trust the historical
//! key version recorded on each `channel_message` row and look it up here.
//! Encryption and signing public keys intentionally rotate together as one bundle tuple; clients
//! treat any version change as a tuple that must be observed and confirmed.
//!
//! Reducer enforces `(agent_db_id, key_bundle_version)` uniqueness via pre-insert lookup on the
//! 2-col btree below.

use spacetimedb::Timestamp;

use crate::constants::{EncryptionAlgorithm, SigningAlgorithm};

#[spacetimedb::table(accessor = agent_key_bundle,
    index(accessor = agent_key_bundle_agent_db_id, btree(columns = [agent_db_id])),
    index(accessor = agent_key_bundle_agent_db_id_key_bundle_version,
          btree(columns = [agent_db_id, key_bundle_version])),
)]
#[derive(Debug, Clone)]
pub struct AgentKeyBundle {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub agent_db_id: u64,

    pub key_bundle_version: u32,

    pub encryption_public_key: String,
    pub encryption_algorithm: EncryptionAlgorithm,

    pub signing_public_key: String,
    pub signing_algorithm: SigningAlgorithm,

    /// Append-only in normal use; `updated_at == created_at` at insert.
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
