//! `revoke_device` — flip the device to `Revoked` and invalidate any pending share / bundle.

use spacetimedb::ReducerContext;

use crate::constants::DeviceStatus;
use crate::helpers::account_signals::bump_owned_devices_signal;
use crate::helpers::accounts::get_owned_account;
use crate::helpers::auth_lease::upsert_lease_for_account;
use crate::helpers::devices::{invalidate_pending_key_bundles, invalidate_pending_share_requests};
use crate::helpers::oidc::require_oidc_claims;
use crate::tables::*;

#[spacetimedb::reducer]
pub fn revoke_device(ctx: &ReducerContext, device_id: String) -> Result<(), String> {
    let account = get_owned_account(ctx)?;
    let claims = require_oidc_claims(ctx)?;
    upsert_lease_for_account(ctx, &account, &claims)?;

    let device = ctx
        .db
        .device()
        .device_id()
        .find(device_id.clone())
        .ok_or_else(|| "Device not found".to_string())?;
    if device.account_id != account.id {
        return Err("Device is owned by a different account".to_string());
    }
    if matches!(device.status, DeviceStatus::Revoked) && device.revoked_at.is_some() {
        return Ok(());
    }

    invalidate_pending_share_requests(ctx, account.id, &device.device_id);
    invalidate_pending_key_bundles(ctx, account.id, &device.device_id);

    let updated = Device {
        status: DeviceStatus::Revoked,
        revoked_at: Some(ctx.timestamp),
        last_seen_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        ..device
    };
    ctx.db.device().id().update(updated);
    bump_owned_devices_signal(ctx, account.id);

    Ok(())
}
