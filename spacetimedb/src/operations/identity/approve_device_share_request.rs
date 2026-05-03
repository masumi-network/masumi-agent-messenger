//! `approve_device_share_request` — owner approves a pending share request from an existing
//! approved device. Inserts the wrapped key bundle ciphertext for the new device to claim.
//!
//! Renamed from `approveDeviceShare` for symmetry with `create_device_share_request`.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    DeviceBundleAlgorithm, DeviceEncryptionAlgorithm, DeviceKeyBundlePurpose, DeviceStatus,
    ScheduledExpiryKind, AES_GCM_IV_BYTES, DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS,
    MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES, MAX_PUBLIC_KEY_CHARS,
};
use crate::helpers::account_signals::bump_owned_devices_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::find_approved_device_by_public_key_tuple;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::scheduling::schedule_expiry;
use crate::helpers::time::{
    descending_timestamp_key, timestamp_plus_ms, EXCLUDED_DESCENDING_TIMESTAMP_KEY,
};
use crate::helpers::validate::{ensure_byte_len, ensure_exact_byte_len, normalize_required};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn approve_device_share_request(
    ctx: &ReducerContext,
    request_id: u64,
    source_encryption_public_key: String,
    source_encryption_key_version: u32,
    source_encryption_algorithm: DeviceEncryptionAlgorithm,
    bundle_ciphertext: Vec<u8>,
    bundle_iv: Vec<u8>,
    bundle_algorithm: DeviceBundleAlgorithm,
    shared_agent_count: u64,
    shared_key_version_count: u64,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let request = ctx
        .db
        .device_share_request()
        .id()
        .find(&request_id)
        .ok_or_else(|| "Device share request not found".to_string())?;
    if request.account_id != account.id {
        return Err("Device share request is owned by a different account".to_string());
    }
    if request.consumed_at.is_some() {
        return Err("Device share request has already been consumed".to_string());
    }
    if request.approved_at.is_some() {
        return Err("Device share request has already been approved".to_string());
    }
    if request.expires_at <= ctx.timestamp {
        return Err("Device share request has expired".to_string());
    }
    let target_device = ctx
        .db
        .device()
        .device_id()
        .find(request.device_id.clone())
        .ok_or_else(|| "Target device not found".to_string())?;
    if target_device.account_id != account.id {
        return Err("Target device is owned by a different account".to_string());
    }

    let normalized_source_key = normalize_required(
        &source_encryption_public_key,
        MAX_PUBLIC_KEY_CHARS,
        "sourceEncryptionPublicKey",
    )?;
    let source_device = find_approved_device_by_public_key_tuple(
        ctx,
        account.id,
        &normalized_source_key,
        source_encryption_key_version,
        source_encryption_algorithm,
    )
    .ok_or_else(|| "Source device key is not an approved account device".to_string())?;
    // Device attribution is account-trusted: OIDC account ownership is the trust boundary for
    // approving and sharing key material between approved devices. The source device is inferred
    // from the submitted public-key tuple rather than accepted as a free-form device id.
    ensure_byte_len(
        &bundle_ciphertext,
        MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES,
        "bundleCiphertext",
    )?;
    ensure_exact_byte_len(&bundle_iv, AES_GCM_IV_BYTES, "bundleIv")?;

    let updated_request = DeviceShareRequest {
        approved_at: Some(ctx.timestamp),
        consumed_at: Some(ctx.timestamp),
        pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        updated_at: ctx.timestamp,
        ..request.clone()
    };
    ctx.db.device_share_request().id().update(updated_request);

    ctx.db.device().id().update(Device {
        status: DeviceStatus::Approved,
        approved_at: target_device.approved_at.or(Some(ctx.timestamp)),
        revoked_at: None,
        last_seen_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        ..target_device
    });
    bump_owned_devices_signal(ctx, account.id);

    let expires_at = timestamp_plus_ms(ctx.timestamp, DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS as i64);

    let bundle = ctx.db.device_key_bundle().insert(DeviceKeyBundle {
        id: 0,
        target_device_id: request.device_id.clone(),
        source_device_id: source_device.device_id,
        account_id: account.id,
        source_encryption_public_key: normalized_source_key,
        source_encryption_key_version,
        source_encryption_algorithm,
        bundle_ciphertext,
        bundle_iv,
        bundle_algorithm,
        purpose: DeviceKeyBundlePurpose::InitialOnboarding,
        shared_agent_count,
        shared_key_version_count,
        expires_at,
        consumed_at: None,
        pending_sort_key: descending_timestamp_key(ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::DeviceKeyBundle,
        bundle.id,
        expires_at,
    );

    Ok(())
}
