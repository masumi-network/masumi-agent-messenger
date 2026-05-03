//! Timestamp math — ms/micros conversion, expiry check, addition.
//!
//! `Timestamp` micros precision is preserved (`i64`); ms inputs from constants are converted
//! at the boundary. Views must NOT call `Timestamp::now()` (non-deterministic, unavailable on
//! wasm32); always read `ctx.timestamp` instead.

use spacetimedb::{TimeDuration, Timestamp};

pub const EXCLUDED_DESCENDING_TIMESTAMP_KEY: i64 = i64::MAX;

#[inline]
pub fn ms_to_micros(milliseconds: i64) -> i64 {
    milliseconds.saturating_mul(1_000)
}

#[inline]
pub fn timestamp_plus_ms(value: Timestamp, milliseconds: i64) -> Timestamp {
    value + TimeDuration::from_micros(ms_to_micros(milliseconds))
}

#[inline]
pub fn descending_timestamp_key(value: Timestamp) -> i64 {
    0i64.saturating_sub(value.to_micros_since_unix_epoch())
}

#[inline]
pub fn is_timestamp_expired(expires_at: Timestamp, now: Timestamp) -> bool {
    expires_at <= now
}
