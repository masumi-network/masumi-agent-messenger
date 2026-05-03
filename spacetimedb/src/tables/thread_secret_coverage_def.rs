//! `thread_secret_coverage` — verified coverage cache for sender secret versions.
//!
//! Rotation messages still validate and insert every `thread_secret_envelope`. Normal messages can
//! then check this compact row for the stable tuple instead of re-reading every envelope and key
//! bundle on each send. The fingerprint binds the current sender/recipient key bundle versions, so
//! key rotation still forces a fresh sender-secret rotation.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = thread_secret_coverage,
    index(accessor = thread_secret_coverage_tuple,
          btree(columns = [thread_id, membership_version, sender_agent_db_id, secret_version])),
    index(accessor = thread_secret_coverage_thread_id, btree(columns = [thread_id])),
)]
#[derive(Debug, Clone)]
pub struct ThreadSecretCoverage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub thread_id: u64,
    pub membership_version: u64,
    pub sender_agent_db_id: u64,
    pub secret_version: u32,

    pub participant_count: u32,
    pub sender_key_bundle_version: u32,
    pub recipient_versions_fingerprint: String,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
