//! `device_share_request` — out-of-band device approval flow.
//!
//! A new device generates a verification code; the inbox owner approves it from an existing
//! device. The shared secret bundle for the new device is then issued via `device_key_bundle`.

use spacetimedb::Timestamp;

#[spacetimedb::table(accessor = device_share_request,
    index(accessor = device_share_request_device_id, btree(columns = [device_id])),
    index(accessor = device_share_request_device_id_account_id,
          btree(columns = [device_id, account_id])),
    index(accessor = device_share_request_account_id, btree(columns = [account_id])),
    index(accessor = device_share_request_account_id_pending_sort_key,
          btree(columns = [account_id, pending_sort_key])),
)]
#[derive(Debug, Clone)]
pub struct DeviceShareRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    pub device_id: String,

    pub account_id: u64,

    /// Indexed string form (`sha256-v1:<hex>`). `Vec<u8>` is not filterable by SpacetimeDB, so the
    /// hash stays in a canonical text encoding while the code itself remains client-only.
    #[unique]
    pub verification_code_hash: String,

    pub client_created_at: Timestamp,
    pub expires_at: Timestamp,

    pub approved_at: Option<Timestamp>,
    pub consumed_at: Option<Timestamp>,
    /// `-created_at` while pending; `i64::MAX` once approved/consumed.
    pub pending_sort_key: i64,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
