//! `register_device` — caller-initiated device registration / refresh.
//!
//! New device → status `Pending` until approved via the share-request flow. Existing device
//! re-registration with unchanged keys → idempotent no-op. Existing device with rotated keys →
//! status flips back to `Pending` and any pending share-requests / key-bundles are invalidated
//! (driven by `helpers::devices::upsert_device`).

use spacetimedb::ReducerContext;

use crate::constants::DeviceEncryptionAlgorithm;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::{upsert_device, DeviceUpsertParams};
use crate::helpers::oidc::require_oidc_claims;

#[spacetimedb::reducer]
pub fn register_device(
    ctx: &ReducerContext,
    device_id: String,
    label: Option<String>,
    platform: Option<String>,
    device_encryption_public_key: String,
    device_encryption_key_version: u32,
    device_encryption_algorithm: DeviceEncryptionAlgorithm,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    upsert_device(
        ctx,
        account.id,
        DeviceUpsertParams {
            device_id: &device_id,
            label: label.as_deref(),
            platform: platform.as_deref(),
            device_encryption_public_key: &device_encryption_public_key,
            device_encryption_key_version,
            device_encryption_algorithm,
            auto_approve: false,
        },
    )?;

    Ok(())
}
