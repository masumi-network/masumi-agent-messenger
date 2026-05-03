//! `rate_limit` — per-bucket sliding-window counter.
//!
//! `action` is a native enum (`RateLimitAction`). Each bucket is keyed on
//! `bucket_key = "<action>:<owner-or-pair>"` (stable string built by reducers).
//!
//! Drops the old `rate_limit_report`, `rate_limit_report_cleanup`, and `rate_limit_cleanup`
//! tables. Violation observability moves to logs/metrics. Bucket expiry routes through the
//! unified `scheduled_expiry` dispatcher (kind = `ScheduledExpiryKind::RateLimit`).

use spacetimedb::{Identity, Timestamp};

use crate::constants::RateLimitAction;

#[spacetimedb::table(accessor = rate_limit)]
#[derive(Debug, Clone)]
pub struct RateLimit {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[unique]
    pub bucket_key: String,

    pub action: RateLimitAction,
    pub owner_identity: Identity,

    pub window_start: Timestamp,
    pub expires_at: Timestamp,

    pub count: u64,
    pub limited_count: u64,

    pub first_limited_at: Option<Timestamp>,
    pub last_limited_at: Option<Timestamp>,

    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
