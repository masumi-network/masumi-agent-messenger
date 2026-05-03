//! `create_device_share_request` — new device begins approval flow.
//!
//! The new device generates a verification code, hashes it client-side, and sends the hash here.
//! The owner approves the request from an existing approved device, which then calls
//! `claim_device_key_bundle` to retrieve the wrapped agent secrets.

use spacetimedb::{ReducerContext, Table};

use crate::constants::{
    RateLimitAction, ScheduledExpiryKind, DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS,
    DEVICE_SHARE_REQUEST_RATE_MAX_PER_WINDOW, DEVICE_SHARE_REQUEST_RATE_WINDOW_MS,
    MAX_DEVICE_ID_CHARS,
};
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::{invalidate_pending_key_bundles, invalidate_pending_share_requests};
use crate::helpers::oidc::require_oidc_claims;
use crate::helpers::rate_limit::{bucket_key, enforce, EnforceParams};
use crate::helpers::scheduling::schedule_expiry;
use crate::helpers::time::{descending_timestamp_key, timestamp_plus_ms};
use crate::helpers::validate::{normalize_required, normalize_verification_code_hash};
use crate::tables::*;

#[spacetimedb::reducer]
pub fn create_device_share_request(
    ctx: &ReducerContext,
    device_id: String,
    verification_code_hash: String,
    client_created_at: spacetimedb::Timestamp,
) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let normalized_device_id = normalize_required(&device_id, MAX_DEVICE_ID_CHARS, "deviceId")?;
    let normalized_hash = normalize_verification_code_hash(&verification_code_hash)?;
    let bk = bucket_key(
        RateLimitAction::DeviceShareRequest,
        ctx.sender(),
        Some(&normalized_device_id),
    );
    if !enforce(
        ctx,
        EnforceParams {
            bucket_key: &bk,
            action: RateLimitAction::DeviceShareRequest,
            owner_identity: ctx.sender(),
            window_ms: DEVICE_SHARE_REQUEST_RATE_WINDOW_MS as i64,
            max_count: DEVICE_SHARE_REQUEST_RATE_MAX_PER_WINDOW,
        },
    ) {
        return Err("Device share request rate limit exceeded; try again later".to_string());
    }

    let expires_at = timestamp_plus_ms(ctx.timestamp, DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS as i64);

    let device = ctx
        .db
        .device()
        .device_id()
        .find(normalized_device_id.clone())
        .ok_or_else(|| "Device not found".to_string())?;
    if device.account_id != account.id {
        return Err("Device is owned by a different account".to_string());
    }
    invalidate_pending_share_requests(ctx, account.id, &normalized_device_id);
    invalidate_pending_key_bundles(ctx, account.id, &normalized_device_id);

    let request = ctx.db.device_share_request().insert(DeviceShareRequest {
        id: 0,
        device_id: normalized_device_id,
        account_id: account.id,
        verification_code_hash: normalized_hash,
        client_created_at,
        expires_at,
        approved_at: None,
        consumed_at: None,
        pending_sort_key: descending_timestamp_key(ctx.timestamp),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    schedule_expiry(
        ctx,
        ScheduledExpiryKind::DeviceShareRequest,
        request.id,
        expires_at,
    );

    Ok(())
}
