//! OIDC claim extraction + identity-key construction.
//!
//! The Rust SDK exposes JWT claims via `ctx.sender_auth().jwt()` — `subject()`, `issuer()`,
//! `audience()`, `raw_payload()` (json string for custom claims). This module decodes the
//! claims relevant to inbox auth: email, email_verified, exp, sid, jti, name. Issuer and
//! audience are validated against the trust list compiled into `crate::constants`.
//!
//! `account.auth_identity_key` is the canonical `<issuer>\0<subject>` join used to
//! uniquely identify an OIDC user across rotations. NUL is the separator because issuers
//! never contain NUL and `(issuer, subject)` pairs are unique per provider.

use spacetimedb::{ReducerContext, Timestamp};

use crate::constants::{TRUSTED_OIDC_AUDIENCES, TRUSTED_OIDC_ISSUERS};
use crate::helpers::time::is_timestamp_expired;
use crate::helpers::validate::{require_non_empty, require_valid_email};

const OIDC_CLOCK_SKEW_SECONDS: i64 = 300;

/// Hard cap on the JWT payload byte length before JSON deserialization. Trusted issuers do not
/// mint payloads remotely close to this; the cap exists to bound CPU/memory per reducer call
/// even if a trusted issuer is misconfigured or compromised at the signing boundary.
const MAX_JWT_RAW_PAYLOAD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct OidcClaims {
    /// Normalized form (lowercased + trimmed by `require_valid_email`). The original casing
    /// is intentionally not preserved — write-time normalization keeps `account.email` the
    /// single source of truth and avoids the dual-column drift the old schema had.
    pub email: String,
    pub subject: String,
    pub issuer: String,
    pub session_id: Option<String>,
    pub jwt_id: Option<String>,
    pub display_name: Option<String>,
    pub expires_at: Timestamp,
}

pub fn build_auth_identity_key(issuer: &str, subject: &str) -> String {
    format!("{issuer}\u{0000}{subject}")
}

fn read_string_claim(payload: &serde_json::Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn read_bool_claim(payload: &serde_json::Value, key: &str) -> bool {
    match payload.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn read_numeric_claim(payload: &serde_json::Value, key: &str) -> Option<i64> {
    match payload.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(serde_json::Value::String(s)) if s.chars().all(|c| c.is_ascii_digit()) => {
            s.parse().ok()
        }
        _ => None,
    }
}

fn timestamp_from_seconds(seconds: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(seconds.saturating_mul(1_000_000))
}

pub fn require_oidc_claims(ctx: &ReducerContext) -> Result<OidcClaims, String> {
    let auth = ctx.sender_auth();
    // Load-bearing trust boundary: `ReducerContext::sender_auth()` is built from the
    // connection id and the Rust SDK loads JWT claims through the host (`rt::get_jwt`), not
    // from reducer arguments. The host auth layer owns bearer/JWKS verification before claims
    // are bound to this connection; reducers then validate app-specific claims below.
    let jwt = auth
        .jwt()
        .ok_or_else(|| "OIDC authentication is required before this action".to_string())?;

    let issuer = jwt.issuer().to_string();
    if !TRUSTED_OIDC_ISSUERS.contains(&issuer.as_str()) {
        spacetimedb::log::warn!(
            "Rejected OIDC issuer {:?}; trusted issuers: {:?}",
            issuer,
            TRUSTED_OIDC_ISSUERS
        );
        return Err("Unauthorized issuer".to_string());
    }
    if !jwt
        .audience()
        .iter()
        .any(|aud| TRUSTED_OIDC_AUDIENCES.contains(&aud.as_str()))
    {
        return Err("Unauthorized audience".to_string());
    }

    let raw_payload = jwt.raw_payload();
    if raw_payload.len() > MAX_JWT_RAW_PAYLOAD_BYTES {
        return Err("OIDC token payload exceeds the maximum allowed size".to_string());
    }
    let payload: serde_json::Value = serde_json::from_str(raw_payload)
        .map_err(|_| "OIDC token payload is not valid JSON".to_string())?;

    let raw_email = require_non_empty(
        read_string_claim(&payload, "email")
            .as_deref()
            .unwrap_or(""),
        "jwt.email",
    )?;
    if !read_bool_claim(&payload, "email_verified") {
        return Err("OIDC token requires email_verified=true".to_string());
    }
    let exp = read_numeric_claim(&payload, "exp")
        .ok_or_else(|| "OIDC token exp claim is required".to_string())?;
    let expires_at = timestamp_from_seconds(exp);
    let now = ctx
        .timestamp
        .to_micros_since_unix_epoch()
        .saturating_div(1_000_000);
    if exp.saturating_add(OIDC_CLOCK_SKEW_SECONDS) <= now {
        return Err("OIDC token is expired".to_string());
    }
    if let Some(nbf) = read_numeric_claim(&payload, "nbf") {
        if now.saturating_add(OIDC_CLOCK_SKEW_SECONDS) < nbf {
            return Err("OIDC token is not yet valid".to_string());
        }
    }
    if let Some(iat) = read_numeric_claim(&payload, "iat") {
        if iat > now.saturating_add(OIDC_CLOCK_SKEW_SECONDS) {
            return Err("OIDC token iat is in the future".to_string());
        }
        if iat > exp.saturating_add(OIDC_CLOCK_SKEW_SECONDS) {
            return Err("OIDC token iat is after exp".to_string());
        }
    }

    Ok(OidcClaims {
        email: require_valid_email(&raw_email, "jwt.email")?,
        subject: require_non_empty(jwt.subject(), "jwt.sub")?,
        issuer: require_non_empty(&issuer, "jwt.iss")?,
        session_id: read_string_claim(&payload, "sid"),
        jwt_id: read_string_claim(&payload, "jti"),
        display_name: read_string_claim(&payload, "name"),
        expires_at,
    })
}

pub fn require_future_oidc_expiry(
    ctx: &ReducerContext,
    claims: &OidcClaims,
) -> Result<Timestamp, String> {
    if is_timestamp_expired(claims.expires_at, ctx.timestamp) {
        return Err("OIDC token is expired".to_string());
    }
    Ok(claims.expires_at)
}

/// SpacetimeDB scheduled reducers run with `connection_id == None` — assert that to gate
/// scheduler-only entry points (`expire_scheduled` dispatcher) from spoofed client calls.
pub fn require_scheduled_call(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.connection_id().is_some() {
        return Err("This reducer can only be called by the scheduler".to_string());
    }
    Ok(())
}
