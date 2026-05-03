//! Device upsert + key-rotation invalidation.

use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::constants::{
    DeviceEncryptionAlgorithm, DeviceStatus, ScheduledExpiryKind, MAX_DEVICE_ID_CHARS,
    MAX_DEVICE_LABEL_CHARS, MAX_DEVICE_PLATFORM_CHARS, MAX_PUBLIC_KEY_CHARS,
};
use crate::helpers::account_signals::bump_owned_devices_signal;
use crate::helpers::scheduling::cancel_expiry_for;
use crate::helpers::time::EXCLUDED_DESCENDING_TIMESTAMP_KEY;
use crate::helpers::validate::{normalize_optional, normalize_required};
use crate::tables::*;

pub struct DeviceUpsertParams<'a> {
    pub device_id: &'a str,
    pub label: Option<&'a str>,
    pub platform: Option<&'a str>,
    pub device_encryption_public_key: &'a str,
    pub device_encryption_key_version: u32,
    pub device_encryption_algorithm: DeviceEncryptionAlgorithm,
    pub auto_approve: bool,
}

pub fn find_approved_device_by_public_key_tuple(
    ctx: &ReducerContext,
    account_id: u64,
    public_key: &str,
    key_version: u32,
    algorithm: DeviceEncryptionAlgorithm,
) -> Option<Device> {
    ctx.db
        .device()
        .device_account_id_id()
        .filter((account_id, 0u64..))
        .filter(|device| {
            matches!(device.status, DeviceStatus::Approved)
                && device.device_encryption_public_key == public_key
                && device.device_encryption_key_version == key_version
                && device.device_encryption_algorithm == algorithm
        })
        .min_by_key(|device| device.id)
}

pub fn upsert_device(
    ctx: &ReducerContext,
    account_id: u64,
    params: DeviceUpsertParams<'_>,
) -> Result<Device, String> {
    let DeviceUpsertParams {
        device_id,
        label,
        platform,
        device_encryption_public_key,
        device_encryption_key_version,
        device_encryption_algorithm,
        auto_approve,
    } = params;

    let normalized_device_id = normalize_required(device_id, MAX_DEVICE_ID_CHARS, "deviceId")?;
    let normalized_label = normalize_optional(label, MAX_DEVICE_LABEL_CHARS, "deviceLabel")?;
    let normalized_platform =
        normalize_optional(platform, MAX_DEVICE_PLATFORM_CHARS, "devicePlatform")?;
    let normalized_public_key = normalize_required(
        device_encryption_public_key,
        MAX_PUBLIC_KEY_CHARS,
        "deviceEncryptionPublicKey",
    )?;
    if device_encryption_key_version == 0 {
        return Err("deviceEncryptionKeyVersion must be > 0".to_string());
    }

    let table = ctx.db.device();
    let existing = table.device_id().find(normalized_device_id.clone());

    if let Some(existing) = existing {
        if existing.account_id != account_id {
            return Err("device_id is owned by a different account".to_string());
        }
        let key_changed = existing.device_encryption_public_key != normalized_public_key
            || existing.device_encryption_key_version != device_encryption_key_version
            || existing.device_encryption_algorithm != device_encryption_algorithm;
        let should_reset = existing.revoked_at.is_some() || key_changed;
        if auto_approve && should_reset {
            return Err(
                "Existing device must keep the same approved key tuple; use device share approval for a changed or revoked device"
                    .to_string(),
            );
        }
        if key_changed {
            invalidate_pending_share_requests(ctx, account_id, &normalized_device_id);
            invalidate_pending_key_bundles(ctx, account_id, &normalized_device_id);
        }
        let status = if auto_approve {
            DeviceStatus::Approved
        } else if should_reset {
            DeviceStatus::Pending
        } else if existing.approved_at.is_some() {
            DeviceStatus::Approved
        } else {
            existing.status
        };
        let approved_at: Option<Timestamp> = if auto_approve {
            existing.approved_at.or(Some(ctx.timestamp))
        } else if should_reset {
            None
        } else {
            existing.approved_at
        };
        let revoked_at: Option<Timestamp> = if auto_approve || should_reset {
            None
        } else {
            existing.revoked_at
        };
        let updated = Device {
            label: normalized_label.clone(),
            platform: normalized_platform.clone(),
            device_encryption_public_key: normalized_public_key.clone(),
            device_encryption_key_version,
            device_encryption_algorithm,
            status,
            approved_at,
            revoked_at,
            last_seen_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            ..existing
        };
        let device = table.id().update(updated);
        bump_owned_devices_signal(ctx, account_id);
        Ok(device)
    } else {
        let approved_at = if auto_approve {
            Some(ctx.timestamp)
        } else {
            None
        };
        let device = table.insert(Device {
            id: 0,
            account_id,
            device_id: normalized_device_id,
            label: normalized_label,
            platform: normalized_platform,
            device_encryption_public_key: normalized_public_key,
            device_encryption_key_version,
            device_encryption_algorithm,
            status: if auto_approve {
                DeviceStatus::Approved
            } else {
                DeviceStatus::Pending
            },
            approved_at,
            revoked_at: None,
            last_seen_at: ctx.timestamp,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
        bump_owned_devices_signal(ctx, account_id);
        Ok(device)
    }
}

pub fn invalidate_pending_share_requests(ctx: &ReducerContext, account_id: u64, device_id: &str) {
    let table = ctx.db.device_share_request();
    let to_update: Vec<DeviceShareRequest> = table
        .device_share_request_device_id_account_id()
        .filter((device_id, account_id))
        .filter(|r| r.consumed_at.is_none())
        .collect();
    for r in to_update {
        cancel_expiry_for(ctx, ScheduledExpiryKind::DeviceShareRequest, r.id);
        let updated = DeviceShareRequest {
            consumed_at: Some(ctx.timestamp),
            pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
            updated_at: ctx.timestamp,
            ..r
        };
        table.id().update(updated);
    }
}

pub fn invalidate_pending_key_bundles(ctx: &ReducerContext, account_id: u64, device_id: &str) {
    let table = ctx.db.device_key_bundle();
    let to_update: Vec<DeviceKeyBundle> = table
        .device_key_bundle_target_device_id_pending_sort_key()
        .filter((device_id, ..EXCLUDED_DESCENDING_TIMESTAMP_KEY))
        .filter(|b| b.account_id == account_id)
        .collect();
    for b in to_update {
        let updated = DeviceKeyBundle {
            consumed_at: Some(ctx.timestamp),
            pending_sort_key: EXCLUDED_DESCENDING_TIMESTAMP_KEY,
            updated_at: ctx.timestamp,
            ..b
        };
        table.id().update(updated);
    }
}
