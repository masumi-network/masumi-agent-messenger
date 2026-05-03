//! `resolve_device_share_request_by_code` — match a verification-code hash against pending
//! device-share requests, return the request joined with the requesting device's public key
//! material so the approving client can verify the code matches.
//!
//! The argon2 hashing happens client-side (the new device hashed when it created the request;
//! the approving device hashes the user-typed code with the same parameters before calling).
//! Server-side hashing would require pulling Argon2 into the wasm module — not worth the
//! payload weight for one procedure.

use spacetimedb::ProcedureContext;

use super::types::ResolvedDeviceShareRequestRow;
use crate::constants::{
    DeviceEncryptionAlgorithm, RateLimitAction, DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW,
    DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS,
};
use crate::helpers::rate_limit::{bucket_key, enforce_in_tx, EnforceParams};
use crate::helpers::validate::normalize_verification_code_hash;
use crate::tables::*;

#[spacetimedb::procedure]
pub fn resolve_device_share_request_by_code(
    ctx: &mut ProcedureContext,
    verification_code_hash: String,
) -> Vec<ResolvedDeviceShareRequestRow> {
    let sender = ctx.sender();
    let timestamp = ctx.timestamp;
    ctx.with_tx(|tx| {
        let Ok(normalized_hash) = normalize_verification_code_hash(&verification_code_hash) else {
            return Vec::new();
        };
        let bk = bucket_key(RateLimitAction::DeviceShareResolve, sender, None);
        if !enforce_in_tx(
            tx,
            timestamp,
            EnforceParams {
                bucket_key: &bk,
                action: RateLimitAction::DeviceShareResolve,
                owner_identity: sender,
                window_ms: DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS as i64,
                max_count: DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW,
            },
        ) {
            return Vec::new();
        }
        tx.db
            .device_share_request()
            .verification_code_hash()
            .find(normalized_hash)
            .filter(|r| {
                r.approved_at.is_none() && r.consumed_at.is_none() && r.expires_at > timestamp
            })
            .into_iter()
            .filter_map(|request| {
                let device = tx.db.device().device_id().find(&request.device_id)?;
                if device.account_id != request.account_id {
                    return None;
                }
                Some(ResolvedDeviceShareRequestRow {
                    request_id: request.id,
                    device_id: request.device_id,
                    label: device.label,
                    platform: device.platform,
                    device_encryption_public_key: device.device_encryption_public_key,
                    device_encryption_key_version: device.device_encryption_key_version,
                    device_encryption_algorithm: device_encryption_algorithm_label(
                        &device.device_encryption_algorithm,
                    ),
                    client_created_at: request.client_created_at,
                    expires_at: request.expires_at,
                    created_at: request.created_at,
                })
            })
            .collect()
    })
}

fn device_encryption_algorithm_label(algorithm: &DeviceEncryptionAlgorithm) -> String {
    match algorithm {
        DeviceEncryptionAlgorithm::EcdhP256DeviceV1 => "ecdh-p256-device-v1".into(),
    }
}
