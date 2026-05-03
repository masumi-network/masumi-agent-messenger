//! `device` — approved device under an account.
//!
//! Multi-device per account is supported. `device_id` is the client-generated unique identifier
//! (was synthesized via the dropped `uniqueKey`; now native unique on this column).

use spacetimedb::Timestamp;

use crate::constants::{DeviceEncryptionAlgorithm, DeviceStatus};

#[spacetimedb::table(accessor = device,
    index(accessor = device_account_id, btree(columns = [account_id])),
    index(accessor = device_account_id_id, btree(columns = [account_id, id])),
)]
#[derive(Debug, Clone)]
pub struct Device {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub account_id: u64,

    #[unique]
    pub device_id: String,

    pub label: Option<String>,
    pub platform: Option<String>,

    pub device_encryption_public_key: String,
    pub device_encryption_key_version: u32,
    pub device_encryption_algorithm: DeviceEncryptionAlgorithm,

    pub status: DeviceStatus,

    pub approved_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub last_seen_at: Timestamp,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
