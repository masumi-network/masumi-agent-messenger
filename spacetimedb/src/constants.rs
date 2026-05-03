//! Module-level constants and enums.
//!
//! Replaces `spacetimedb/src/models/constants.ts` after the Rust port.
//!
//! Per plan "Type Improvements" section: every status / mode / kind / permission / algorithm
//! string column is promoted to a `#[derive(SpacetimeType)]` Rust enum so callers get compile-
//! time safety, smaller indexes, and faster compares.
//!
//! Dropped from the original constants:
//! - `MAX_INBOX_THREAD_BACKFILL_BATCH_SIZE` (table dropped)
//! - `MAX_PUBLIC_RECENT_CHANNEL_MESSAGE_VIEW_ROWS` (mirror table dropped)
//! - `MAX_PUBLIC_CHANNEL_PAGE_SIZE` (anon channel discovery dropped)
//! - `DEVICE_KEY_BUNDLE_EXPIRY_MODES` + variants (`expiryMode` field dropped)
//! - `RATE_LIMIT_REPORT_RETENTION_MS` (`rateLimitReport` table dropped)
//!
//! Renamed: `INBOX_AUTH_LEASE_DURATION_MS` → `ACCOUNT_AUTH_LEASE_DURATION_MS`.

use spacetimedb::SpacetimeType;

// -- Length / size limits -----------------------------------------------------

pub const MAX_DEVICE_ID_CHARS: usize = 128;
pub const MAX_DISPLAY_NAME_CHARS: usize = 160;
pub const MAX_THREAD_TITLE_CHARS: usize = 200;
pub const MAX_CHANNEL_SLUG_CHARS: usize = 120;
pub const MAX_CHANNEL_TITLE_CHARS: usize = 200;
pub const MAX_CHANNEL_DESCRIPTION_CHARS: usize = 2_000;
pub const MAX_PUBLIC_DESCRIPTION_CHARS: usize = 2_000;
pub const MAX_PUBLIC_KEY_CHARS: usize = 4096;
pub const MAX_DEVICE_LABEL_CHARS: usize = 120;
pub const MAX_DEVICE_PLATFORM_CHARS: usize = 120;
pub const MAX_MASUMI_NETWORK_CHARS: usize = 32;
pub const MAX_MASUMI_REGISTRATION_ID_CHARS: usize = 128;
pub const MAX_MASUMI_AGENT_IDENTIFIER_CHARS: usize = 256;
pub const MAX_AGENT_SUPPORTED_LIST_LEN: usize = 32;
pub const MAX_AGENT_SUPPORTED_ENTRY_CHARS: usize = 128;

// -- Crypto byte-length caps --------------------------------------------------
//
// All `ciphertext`, `iv`, `signature`, `wrapped_secret_*`, and `bundle_*` columns store
// **raw bytes** (`Vec<u8>`), not hex strings. Caps are byte-counts, applied via
// `helpers::validate::ensure_byte_len[_exact]`.

/// Cap on `message.ciphertext`. Sized to fit a worst-case serialized JSON envelope around the
/// 5000-char plaintext budget (headers + content type + JSON escaping + UTF-8 expansion + AES-GCM
/// tag). Mirrors the TS `MAX_MESSAGE_CIPHERTEXT_BYTES` in `shared/message-limits.ts`.
pub const MAX_MESSAGE_CIPHERTEXT_BYTES: usize = 144 * 1024;
/// AES-GCM IV — fixed 12 bytes per spec.
pub const AES_GCM_IV_BYTES: usize = 12;
/// Ed25519/ECDSA-P256 signature — fixed 64 bytes per spec.
pub const SIGNATURE_BYTES: usize = 64;

/// Cap on `channel_message.plaintext` (UTF-8 char count). Per product spec.
pub const MAX_CHANNEL_PLAINTEXT_CHARS: usize = 5_000;

/// Cap on `thread_secret_envelope.wrapped_secret_ciphertext`. Wraps a 32-byte sender secret
/// with AES-GCM (32 + 16-byte tag = 48 bytes); 128 leaves headroom for future wrap algos.
pub const MAX_WRAPPED_SECRET_CIPHERTEXT_BYTES: usize = 128;

/// Cap on `device_key_bundle.bundle_ciphertext`. Sized for roughly 2048 current agent keys plus
/// framing headroom; long rotation history should move to chunked export rather than this row.
pub const MAX_DEVICE_BUNDLE_CIPHERTEXT_BYTES: usize = 3 * 1024 * 1024;

/// Verification code hashes are indexed text: `sha256-v1:` plus 64 lowercase hex chars.
pub const MAX_VERIFICATION_CODE_HASH_CHARS: usize = 96;

// -- Fan-out caps -------------------------------------------------------------

/// Maximum participant count per thread. Caps `sendEncryptedMessage` fan-out cost
/// (every participant's `updatedAt` is bumped per send).
pub const MAX_THREAD_FANOUT: usize = 50;

// -- OIDC trust list ----------------------------------------------------------
//
// Generated alongside `shared/generated-oidc-config.ts` by
// `scripts/prepare-spacetime-env.mjs`.
pub use crate::generated_oidc_config::{TRUSTED_OIDC_AUDIENCES, TRUSTED_OIDC_ISSUERS};

// -- Auth / lease lifetimes ---------------------------------------------------

/// Bounded server-side lease window. SpacetimeDB exchanges OIDC tokens for short-lived WS
/// tokens; the lease lets views and reducers ask "is this caller authenticated?" without
/// reading the wall clock from a view.
pub const ACCOUNT_AUTH_LEASE_DURATION_MS: u64 = 5 * 60_000;
pub const ACCOUNT_AUTH_LEASE_REFRESH_THRESHOLD_MS: u64 = 60_000;

pub const DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS: u64 = 15 * 60_000;
pub const THREAD_DELETION_CLEANUP_BATCH_SIZE: usize = 250;
pub const THREAD_DELETION_CLEANUP_RETRY_DELAY_MS: u64 = 1_000;
pub const MAX_THREAD_MESSAGE_RETENTION_MS: u64 = 365 * 24 * 60 * 60_000;
pub const MESSAGE_EXPIRY_CLEANUP_BATCH_SIZE: usize = 500;
pub const THREAD_SECRET_ENVELOPE_GC_BATCH_SIZE: usize = 500;
pub const THREAD_SECRET_ENVELOPE_GC_RETRY_DELAY_MS: u64 = 1_000;
pub const AGENT_KEY_BUNDLE_RETAIN_RECENT: usize = 5;
pub const AGENT_KEY_BUNDLE_ARCHIVE_BATCH_SIZE: usize = 50;
pub const RESOLVED_REQUEST_TOMBSTONE_RETENTION_MS: u64 = 30 * 24 * 60 * 60_000;

// -- Rate limit windows -------------------------------------------------------

pub const EMAIL_LOOKUP_RATE_WINDOW_MS: u64 = 60_000;
pub const EMAIL_LOOKUP_RATE_MAX_PER_WINDOW: u64 = 5;
pub const DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS: u64 = 60_000;
pub const DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW: u64 = 5;
pub const DEVICE_SHARE_REQUEST_RATE_WINDOW_MS: u64 = 60_000;
pub const DEVICE_SHARE_REQUEST_RATE_MAX_PER_WINDOW: u64 = 5;
pub const PUBLIC_CHANNEL_LOOKUP_RATE_WINDOW_MS: u64 = 60_000;
pub const PUBLIC_CHANNEL_LOOKUP_RATE_MAX_PER_WINDOW: u64 = 30;
pub const PUBLIC_AGENT_LOOKUP_RATE_WINDOW_MS: u64 = 60_000;
pub const PUBLIC_AGENT_LOOKUP_RATE_MAX_PER_WINDOW: u64 = 60;
pub const PUBLIC_KEY_LOOKUP_RATE_WINDOW_MS: u64 = 60_000;
pub const PUBLIC_KEY_LOOKUP_RATE_MAX_PER_WINDOW: u64 = 120;
pub const PUBLIC_ROUTE_LOOKUP_RATE_WINDOW_MS: u64 = 60_000;
pub const PUBLIC_ROUTE_LOOKUP_RATE_MAX_PER_WINDOW: u64 = 60;
pub const THREAD_MESSAGE_RATE_WINDOW_MS: u64 = 60_000;
pub const THREAD_MESSAGE_RATE_MAX_PER_WINDOW: u64 = 60;
pub const CHANNEL_MESSAGE_RATE_WINDOW_MS: u64 = 60_000;
pub const CHANNEL_MESSAGE_RATE_MAX_PER_WINDOW: u64 = 60;
pub const CHANNEL_JOIN_REQUEST_RATE_WINDOW_MS: u64 = 60_000;
pub const CHANNEL_JOIN_REQUEST_RATE_MAX_PER_WINDOW: u64 = 5;
pub const CHANNEL_JOIN_RATE_WINDOW_MS: u64 = 60_000;
pub const CHANNEL_JOIN_RATE_MAX_PER_WINDOW: u64 = 10;
pub const CHANNEL_CREATE_RATE_WINDOW_MS: u64 = 3_600_000;
pub const CHANNEL_CREATE_RATE_MAX_PER_WINDOW: u64 = 10;
pub const CHANNEL_ADMIN_RATE_WINDOW_MS: u64 = 60_000;
pub const CHANNEL_ADMIN_RATE_MAX_PER_WINDOW: u64 = 30;
pub const THREAD_ADMIN_RATE_WINDOW_MS: u64 = 60_000;
pub const THREAD_ADMIN_RATE_MAX_PER_WINDOW: u64 = 30;
pub const AGENT_KEY_ROTATE_RATE_WINDOW_MS: u64 = 3_600_000;
pub const AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW: u64 = 10;
pub const DEVICE_BUNDLE_SHARE_RATE_WINDOW_MS: u64 = 60_000;
pub const DEVICE_BUNDLE_SHARE_RATE_MAX_PER_WINDOW: u64 = 120;
pub const CONTACT_REQUEST_RATE_WINDOW_MS: u64 = 3_600_000;
pub const CONTACT_REQUEST_RATE_MAX_PER_WINDOW: u64 = 20;
pub const CONTACT_RESOLVE_RATE_WINDOW_MS: u64 = 60_000;
pub const CONTACT_RESOLVE_RATE_MAX_PER_WINDOW: u64 = 30;

// -- Pagination defaults (procedure `limit` clamps) --------------------------

pub const MAX_VISIBLE_THREAD_PAGE_SIZE: u32 = 25;
pub const MAX_VISIBLE_THREAD_PARTICIPANT_PREVIEW: usize = 3;
pub const MAX_VISIBLE_CHANNEL_PAGE_SIZE: u32 = 25;
pub const MAX_VISIBLE_MESSAGES_PER_THREAD: u32 = 25;
pub const MAX_VISIBLE_AGENT_VIEW_ROWS: u32 = 250;
pub const MAX_AGENT_PAGE_SIZE: u32 = 250;
pub const MAX_PUBLIC_AGENT_EMAIL_LOOKUP_PAGE_SIZE: u32 = 25;
pub const MAX_VISIBLE_CONTACT_ALLOWLIST_VIEW_ROWS: u32 = 500;
pub const MAX_CONTACT_ALLOWLIST_PAGE_SIZE: u32 = 250;
pub const MAX_VISIBLE_DEVICE_VIEW_ROWS: u32 = 100;
pub const MAX_DEVICE_PAGE_SIZE: u32 = 100;
pub const MAX_VISIBLE_PENDING_CONTACT_REQUEST_ROWS: u32 = 250;
pub const MAX_VISIBLE_PENDING_THREAD_INVITE_ROWS: u32 = 250;
pub const MAX_VISIBLE_DEVICE_SHARE_REQUEST_ROWS: u32 = 100;
pub const MAX_VISIBLE_DEVICE_KEY_BUNDLE_ROWS: u32 = 100;
pub const MAX_CHANNEL_RECENT_PUBLIC_MESSAGES: u32 = 25;
pub const MAX_CHANNEL_MESSAGE_PAGE_SIZE: u32 = 25;
pub const MAX_CHANNEL_MEMBER_PAGE_SIZE: u32 = 25;
pub const MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE: u32 = 25;
pub const MAX_CHANNEL_JOIN_REQUEST_VIEW_ROWS: u32 = 250;
pub const MAX_THREAD_MESSAGE_PAGE_SIZE: u32 = 25;
pub const MAX_THREAD_SECRET_ENVELOPE_PAGE_SIZE: u32 = 100;
pub const MAX_AGENT_KEY_BUNDLE_PAGE_SIZE: u32 = 25;
pub const MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS: u32 = 100;
pub const MAX_VISIBLE_DISCOVERABLE_CHANNELS: u32 = 25;
pub const MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE: u32 = 25;

pub const CHANNEL_RECENCY_FANOUT_BATCH_SIZE: usize = 500;
pub const CHANNEL_RECENCY_FANOUT_RETRY_DELAY_MS: u64 = 250;
pub const CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_BATCH_SIZE: usize = 500;
pub const CHANNEL_JOIN_REQUEST_VISIBILITY_FANOUT_RETRY_DELAY_MS: u64 = 250;

// -- Enums --------------------------------------------------------------------
//
// Every enum below is a `#[derive(SpacetimeType)]` Rust enum so it serializes into the
// SpacetimeDB schema natively (Rust equivalent of the TS `t.enum(...)` factory).

/// Thread shape. Direct = exactly two participants, sorted (low, high) agent-pair on `thread`,
/// no title.
/// Group = arbitrary participants, optional title.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadKind {
    Direct,
    Group,
}

/// Channel discovery / join policy. `Public` = open to anyone with the slug; `ApprovalRequired`
/// = requires `channelJoinRequest` approved by an admin.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelAccessMode {
    Public,
    ApprovalRequired,
}

/// Per-member capability inside a channel. `Read` = view only; `ReadWrite` = post messages;
/// `Admin` = manage members + settings.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelPermission {
    Read,
    ReadWrite,
    Admin,
}

/// Lifecycle of a `channelJoinRequest` row.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelJoinRequestStatus {
    Pending,
    Approved,
    Rejected,
}

/// Lifecycle of a `threadInvite` row. `Declined` (was `Rejected` in old schema) reads more
/// naturally for an invite; channel join requests still use approve/reject.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadInviteStatus {
    Pending,
    Accepted,
    Declined,
}

/// Lifecycle of a `contactRequest` row.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContactRequestStatus {
    Pending,
    Approved,
    Rejected,
    Cancelled,
}

/// Discriminator on a `contactAllowlistEntry`. Determines which optional fields are populated
/// on the row (`agentPublicIdentity`+`agentSlug` for `Agent`, `normalizedEmail` for `Email`).
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContactAllowlistKind {
    Agent,
    Email,
}

/// Device lifecycle.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceStatus {
    Pending,
    Approved,
    Revoked,
}

/// Why a `device_key_bundle` was created. Initial onboarding imports are trusted by the
/// verification-code approval flow; rotation shares must be locally confirmed before sending.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyBundlePurpose {
    InitialOnboarding,
    RotationShare,
}

/// Masumi network registration lifecycle. Mirrors the externally-observable states the
/// Masumi registry can return for an inbox-agent registration. The "never registered" state is
/// represented by `Option::None` on `agent.masumi_registration_state` rather than a variant.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasumiRegistrationState {
    PendingRegistration,
    Registered,
    PendingDeregistration,
    Deregistered,
    Failed,
}

/// Bucket key on `rateLimit`. Each variant corresponds to a `_RATE_WINDOW_MS` /
/// `_RATE_MAX_PER_WINDOW` constant pair above.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitAction {
    EmailLookup,
    DeviceShareRequest,
    DeviceShareResolve,
    PublicChannelLookup,
    PublicAgentLookup,
    PublicKeyLookup,
    PublicRouteLookup,
    ThreadMessage,
    ChannelMessage,
    ChannelJoinRequest,
    ChannelJoin,
    ChannelCreate,
    ChannelAdmin,
    ThreadAdmin,
    AgentKeyRotate,
    DeviceBundleShare,
    ContactRequest,
    ContactResolve,
}

/// Public-key encryption algorithm published by an agent (encryption key bundle).
/// Tracks the supported set; clients producing a key bundle MUST pick one of these.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncryptionAlgorithm {
    /// `ecdh-p256-v1` — current default.
    EcdhP256V1,
}

/// Public-key signing algorithm published by an agent (signing key bundle).
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigningAlgorithm {
    /// `ecdsa-p256-sha256-v1` — current default.
    EcdsaP256Sha256V1,
}

/// Public-key encryption algorithm for device-bound bootstrap keys.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceEncryptionAlgorithm {
    /// `ecdh-p256-device-v1` — current default.
    EcdhP256DeviceV1,
}

/// Symmetric algorithm wrapping the device key bundle ciphertext.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceBundleAlgorithm {
    /// `aes-gcm-256-v1` — current default.
    AesGcm256V1,
}

/// Symmetric algorithm encrypting `message.ciphertext`.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageCipherAlgorithm {
    /// `aes-gcm-256-v1` — current default.
    AesGcm256V1,
}

/// Algorithm wrapping a thread's sender-secret per recipient (`threadSecretEnvelope`).
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadSecretWrapAlgorithm {
    /// `ecdh-p256-aes-gcm-256-v1` — derive shared secret via ECDH, wrap with AES-GCM.
    EcdhP256AesGcm256V1,
}

/// Discriminator on a `scheduledExpiry` row. The dispatcher reducer (`expireScheduled`) routes
/// per-kind to the right cleanup logic.
#[derive(SpacetimeType, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledExpiryKind {
    DeviceShareRequest,
    DeviceKeyBundle,
    AccountAuthLease,
    RateLimit,
    ThreadDeletionCleanup,
    ThreadDeletionCleanupPreserveContactRequests,
    MessageExpiry,
    ThreadSecretEnvelopeGc,
    AgentKeyBundleArchive,
    ResolvedRequestTombstone,
    ChannelRecencyFanout,
    ChannelJoinRequestAdminVisibilityFanout,
    ChannelJoinRequestResolvedAdminVisibilityFanout,
}
