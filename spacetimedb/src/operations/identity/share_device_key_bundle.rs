//! `share_device_key_bundle` — owner pushes a freshly wrapped private-key snapshot to another
//! approved device in the same account.
//!
//! This is the rotation-sharing companion to `approve_device_share_request`: no request row is
//! needed because both devices are already approved account devices. The server still stores only
//! opaque ciphertext.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    DeviceBundleAlgorithm, DeviceEncryptionAlgorithm, DeviceKeyBundlePurpose, DeviceStatus,
    RateLimitAction, ScheduledExpiryKind, AES_GCM_IV_BYTES,
    DEVICE_BUNDLE_SHARE_RATE_MAX_PER_WINDOW, DEVICE_BUNDLE_SHARE_RATE_WINDOW_MS,
    DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS, MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES, MAX_DEVICE_ID_CHARS,
    MAX_PUBLIC_KEY_CHARS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::find_approved_device_by_public_key_tuple;
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::scheduling::{cancel_expiry_for, schedule_expiry};
use crate::helpers::time::{
    descending_timestamp_key, timestamp_plus_ms, EXCLUDED_DESCENDING_TIMESTAMP_KEY,
};
use crate::helpers::validate::{ensure_byte_len, ensure_exact_byte_len, normalize_required};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn share_device_key_bundle(
    ctx: &ReducerContext,
    target_device_id: String,
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

    let normalized_target_device_id =
        normalize_required(&target_device_id, MAX_DEVICE_ID_CHARS, "targetDeviceId")?;

    let target_device = ctx
        .db
        .device()
        .device_id()
        .find(normalized_target_device_id.clone())
        .ok_or_else(|| "Target device not found".to_string())?;
    if target_device.account_id != account.id {
        return Err("Target device is owned by a different account".to_string());
    }
    if !matches!(target_device.status, DeviceStatus::Approved) {
        return Err("Target device is not approved".to_string());
    }

    let bk = bucket_key(
        RateLimitAction::DeviceBundleShare,
        ctx.sender(),
        Some(&account.id.to_string()),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::DeviceBundleShare,
            owner_identity: ctx.sender(),
            window_ms: DEVICE_BUNDLE_SHARE_RATE_WINDOW_MS as i64,
            max_count: DEVICE_BUNDLE_SHARE_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Too many device key bundle shares; try again later".to_string());
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
    // Device attribution is account-trusted: once OIDC proves the caller owns the account, any
    // approved device under that account may share/re-share account key material. We derive the
    // displayed source device from the submitted public-key tuple to avoid a free-form device id,
    // but intentionally do not require a per-device proof.
    if source_device.device_id == normalized_target_device_id {
        return Err("Cannot share a device key bundle to the source device".to_string());
    }
    ensure_byte_len(
        &bundle_ciphertext,
        MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES,
        "bundleCiphertext",
    )?;
    ensure_exact_byte_len(&bundle_iv, AES_GCM_IV_BYTES, "bundleIv")?;

    let stale_bundle_ids: Vec<u64> = ctx
        .db
        .device_key_bundle()
        .device_key_bundle_target_device_id_pending_sort_key()
        .filter((
            &normalized_target_device_id[..],
            ..EXCLUDED_DESCENDING_TIMESTAMP_KEY,
        ))
        .filter(|bundle| bundle.account_id == account.id)
        .map(|bundle| bundle.id)
        .collect();
    for stale_bundle_id in stale_bundle_ids {
        cancel_expiry_for(ctx, ScheduledExpiryKind::DeviceKeyBundle, stale_bundle_id);
        ctx.db.device_key_bundle().id().delete(stale_bundle_id);
    }

    let expires_at = timestamp_plus_ms(ctx.timestamp, DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS as i64);
    let bundle = ctx.db.device_key_bundle().insert(DeviceKeyBundle {
        id: 0,
        target_device_id: normalized_target_device_id,
        source_device_id: source_device.device_id,
        account_id: account.id,
        source_encryption_public_key: normalized_source_key,
        source_encryption_key_version,
        source_encryption_algorithm,
        bundle_ciphertext,
        bundle_iv,
        bundle_algorithm,
        purpose: DeviceKeyBundlePurpose::RotationShare,
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
