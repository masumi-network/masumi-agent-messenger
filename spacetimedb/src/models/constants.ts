import { t } from 'spacetimedb/server';

export const MAX_DEVICE_ID_CHARS = 128;
export const MAX_DISPLAY_NAME_CHARS = 160;
export const MAX_THREAD_TITLE_CHARS = 200;
export const MAX_CHANNEL_SLUG_CHARS = 120;
export const MAX_CHANNEL_TITLE_CHARS = 200;
export const MAX_CHANNEL_DESCRIPTION_CHARS = 2_000;
export const MAX_PUBLIC_KEY_CHARS = 4096;
export const MAX_DEVICE_LABEL_CHARS = 120;
export const MAX_DEVICE_PLATFORM_CHARS = 120;
export const MAX_DEVICE_STATUS_CHARS = 32;
export const MAX_DEVICE_VERIFICATION_CODE_HASH_CHARS = 128;
export const MAX_DEVICE_BUNDLE_ALGORITHM_CHARS = 120;
export const MAX_DEVICE_BUNDLE_CIPHERTEXT_HEX_CHARS = 262_144;
export const MAX_MASUMI_NETWORK_CHARS = 32;
export const MAX_MASUMI_REGISTRATION_ID_CHARS = 128;
export const MAX_MASUMI_AGENT_IDENTIFIER_CHARS = 256;
export const MAX_MASUMI_REGISTRATION_STATE_CHARS = 64;
export const MAX_CONTACT_REQUEST_STATUS_CHARS = 32;
export const MAX_CONTACT_ALLOWLIST_KIND_CHARS = 16;
export const MAX_THREAD_FANOUT = 50;
export const DEFAULT_AGENT_ENCRYPTION_ALGORITHM = 'ecdh-p256-v1';
export const DEFAULT_AGENT_SIGNING_ALGORITHM = 'ecdsa-p256-sha256-v1';
export const DEFAULT_DEVICE_ENCRYPTION_ALGORITHM = 'ecdh-p256-device-v1';
export const HEX_PATTERN = /^[0-9a-fA-F]+$/;
export const EMAIL_LOOKUP_RATE_WINDOW_MS = 60_000;
export const EMAIL_LOOKUP_RATE_MAX_PER_WINDOW = 5n;
export const DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS = 60_000;
export const DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW = 5n;
export const CHANNEL_MESSAGE_RATE_WINDOW_MS = 60_000;
export const CHANNEL_MESSAGE_RATE_MAX_PER_WINDOW = 60n;
export const CHANNEL_JOIN_REQUEST_RATE_WINDOW_MS = 60_000;
export const CHANNEL_JOIN_REQUEST_RATE_MAX_PER_WINDOW = 5n;
export const CHANNEL_JOIN_RATE_WINDOW_MS = 60_000;
export const CHANNEL_JOIN_RATE_MAX_PER_WINDOW = 10n;
export const CHANNEL_CREATE_RATE_WINDOW_MS = 3_600_000;
export const CHANNEL_CREATE_RATE_MAX_PER_WINDOW = 10n;
export const CHANNEL_ADMIN_RATE_WINDOW_MS = 60_000;
export const CHANNEL_ADMIN_RATE_MAX_PER_WINDOW = 30n;
export const AGENT_KEY_ROTATE_RATE_WINDOW_MS = 3_600_000;
export const AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW = 10n;
// Contact request creation is rate-limited by (sender, actor) pair.
// Bucket key: `contact_request:<sender>:<actor.id>`.
export const CONTACT_REQUEST_RATE_WINDOW_MS = 3_600_000;
export const CONTACT_REQUEST_RATE_MAX_PER_WINDOW = 20n;
// Shared across approveContactRequest and rejectContactRequest: both resolve a
// pending contact request for the same (sender, actor) pair, so they draw from
// a single bucket. Bucket key: `contact_resolve:<sender>:<actor.id>`.
export const CONTACT_RESOLVE_RATE_WINDOW_MS = 60_000;
export const CONTACT_RESOLVE_RATE_MAX_PER_WINDOW = 30n;
export const INBOX_AUTH_LEASE_DURATION_MS = 5 * 60_000;
export const DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS = 15 * 60_000;
export const RATE_LIMIT_REPORT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEVICE_KEY_BUNDLE_EXPIRY_MODES = ['expires', 'neverExpires'] as const;
export const THREAD_INVITE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export const CHANNEL_ACCESS_MODES = ['public', 'approval_required'] as const;
export const CHANNEL_PERMISSIONS = ['read', 'read_write', 'admin'] as const;
export const CHANNEL_JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const MAX_VISIBLE_THREAD_PAGE_SIZE = 25;
export const MAX_INBOX_THREAD_BACKFILL_BATCH_SIZE = 25;
export const MAX_VISIBLE_MESSAGES_PER_THREAD = 25;
export const MAX_CHANNEL_RECENT_PUBLIC_MESSAGES = 25;
export const MAX_PUBLIC_RECENT_CHANNEL_MESSAGE_VIEW_ROWS = 25;
export const MAX_CHANNEL_MESSAGE_PAGE_SIZE = 25;
export const MAX_CHANNEL_MEMBER_PAGE_SIZE = 25;
export const MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE = 25;
export const MAX_CHANNEL_JOIN_REQUEST_VIEW_ROWS = 250;
export const MAX_THREAD_MESSAGE_PAGE_SIZE = 25;
export const MAX_AGENT_KEY_BUNDLE_PAGE_SIZE = 25;
export const MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS = 100;
export const MAX_VISIBLE_DISCOVERABLE_CHANNELS = 25;
export const MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE = 25;
export const MAX_PUBLIC_CHANNEL_PAGE_SIZE = 25;
export const DeviceKeyBundleExpiryMode = t.enum(
  'DeviceKeyBundleExpiryMode',
  DEVICE_KEY_BUNDLE_EXPIRY_MODES
);
export type DeviceKeyBundleExpiryModeValue = {
  tag: (typeof DEVICE_KEY_BUNDLE_EXPIRY_MODES)[number];
};
export const DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES: DeviceKeyBundleExpiryModeValue = {
  tag: 'expires',
};
export const DEVICE_KEY_BUNDLE_EXPIRY_MODE_NEVER_EXPIRES: DeviceKeyBundleExpiryModeValue = {
  tag: 'neverExpires',
};
