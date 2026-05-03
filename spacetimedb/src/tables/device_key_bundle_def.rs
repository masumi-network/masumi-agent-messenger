//! `device_key_bundle` — encrypted bundle of agent secrets for new-device bootstrapping.
//!
//! Consumed once by the target device, then expired by `scheduled_expiry`
//! (kind = `ScheduledExpiryKind::DeviceKeyBundle`). The bundle ciphertext is wrapped with the
//! target device's public key; the server stores opaque ciphertext only.

use spacetimedb::Timestamp;

use crate::constants::{DeviceBundleAlgorithm, DeviceEncryptionAlgorithm, DeviceKeyBundlePurpose};

#[spacetimedb::table(accessor = device_key_bundle,
    index(accessor = device_key_bundle_target_device_id, btree(columns = [target_device_id])),
    index(accessor = device_key_bundle_target_device_id_account_id,
          btree(columns = [target_device_id, account_id])),
    index(accessor = device_key_bundle_target_device_id_pending_sort_key,
          btree(columns = [target_device_id, pending_sort_key])),
    index(accessor = device_key_bundle_account_id, btree(columns = [account_id])),
    index(accessor = device_key_bundle_account_id_pending_sort_key,
          btree(columns = [account_id, pending_sort_key])),
)]
#[derive(Debug, Clone)]
pub struct DeviceKeyBundle {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub target_device_id: String,
    pub source_device_id: String,
    pub account_id: u64,

    pub source_encryption_public_key: String,
    pub source_encryption_key_version: u32,
    pub source_encryption_algorithm: DeviceEncryptionAlgorithm,

    pub bundle_ciphertext: Vec<u8>,
    pub bundle_iv: Vec<u8>,
    pub bundle_algorithm: DeviceBundleAlgorithm,
    pub purpose: DeviceKeyBundlePurpose,

    pub shared_agent_count: u64,
    pub shared_key_version_count: u64,

    pub expires_at: Timestamp,
    pub consumed_at: Option<Timestamp>,
    /// `-created_at` while unconsumed; `i64::MAX` once claimed/invalidated.
    pub pending_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
