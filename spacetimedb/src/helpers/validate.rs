//! String validation — non-empty, max length, hex pattern, normalized email.
//!
//! All validators return `Result<String, String>` (or `Result<(), String>` for length checks
//! on already-owned values). Callers propagate via `?` from `Result<(), String>` reducers.

use crate::constants::MAX_VERIFICATION_CODE_HASH_CHARS;
use crate::helpers::slug::{is_reserved_slug, normalize_slug};

pub fn require_non_empty(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(trimmed.to_string())
}

pub fn require_max_length(value: &str, max: usize, field: &str) -> Result<(), String> {
    if value.chars().count() > max {
        return Err(format!("{field} must be {max} characters or fewer"));
    }
    Ok(())
}

pub fn ensure_byte_len(bytes: &[u8], max: usize, field: &str) -> Result<(), String> {
    if bytes.is_empty() {
        return Err(format!("{field} is required"));
    }
    if bytes.len() > max {
        return Err(format!("{field} must be {max} bytes or fewer"));
    }
    Ok(())
}

pub fn ensure_exact_byte_len(bytes: &[u8], expected: usize, field: &str) -> Result<(), String> {
    if bytes.len() != expected {
        return Err(format!("{field} must be exactly {expected} bytes"));
    }
    Ok(())
}

pub fn require_hex(value: &str, max: usize, field: &str) -> Result<String, String> {
    let normalized = require_non_empty(value, field)?;
    require_max_length(&normalized, max, field)?;
    if normalized.len() % 2 != 0 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{field} must be even-length hexadecimal"));
    }
    Ok(normalized)
}

pub fn normalize_email(value: &str) -> Result<String, String> {
    let trimmed = require_non_empty(value, "email")?;
    Ok(trimmed.to_lowercase())
}

pub fn require_valid_email(value: &str, field: &str) -> Result<String, String> {
    let normalized = normalize_email(value).map_err(|e| e.replace("email", field))?;
    if !normalized.contains('@') || normalized.starts_with('@') || normalized.ends_with('@') {
        return Err(format!("{field} must be a valid email"));
    }
    Ok(normalized)
}

pub fn normalize_optional(
    value: Option<&str>,
    max: usize,
    field: &str,
) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => {
            require_max_length(v, max, field)?;
            Ok(Some(v.to_string()))
        }
    }
}

pub fn normalize_required(value: &str, max: usize, field: &str) -> Result<String, String> {
    let trimmed = require_non_empty(value, field)?;
    require_max_length(&trimmed, max, field)?;
    Ok(trimmed)
}

pub fn validate_string_list(
    values: Vec<String>,
    max_len: usize,
    max_entry_chars: usize,
    field: &str,
) -> Result<Vec<String>, String> {
    if values.len() > max_len {
        return Err(format!("{field} may include at most {max_len} entries"));
    }

    let mut seen = std::collections::BTreeSet::new();
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let trimmed = require_non_empty(&value, field)?;
        require_max_length(&trimmed, max_entry_chars, field)?;
        if seen.insert(trimmed.clone()) {
            normalized.push(trimmed);
        }
    }
    Ok(normalized)
}

pub fn normalize_verification_code_hash(value: &str) -> Result<String, String> {
    let normalized = normalize_required(
        value,
        MAX_VERIFICATION_CODE_HASH_CHARS,
        "verificationCodeHash",
    )?
    .to_lowercase();
    let Some(hex) = normalized.strip_prefix("sha256-v1:") else {
        return Err("verificationCodeHash must use sha256-v1".to_string());
    };
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("verificationCodeHash must be a SHA-256 hex digest".to_string());
    }
    Ok(normalized)
}

/// Normalize a slug-shaped string (agent slug, channel slug, default slug). Rejects empty
/// and reserved values. Caller is responsible for the per-shape uniqueness check.
pub fn normalize_slug_string(value: &str, field: &str) -> Result<String, String> {
    let normalized = normalize_slug(value);
    if normalized.is_empty() {
        return Err(format!("{field} is required"));
    }
    if is_reserved_slug(&normalized) {
        return Err(format!("{field} is reserved"));
    }
    Ok(normalized)
}

/// Normalize a custom (user-chosen) agent slug.
pub fn normalize_custom_agent_slug(value: &str) -> Result<String, String> {
    normalize_slug_string(value, "slug")
}
