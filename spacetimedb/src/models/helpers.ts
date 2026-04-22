import { SenderError } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import {
  buildPreferredDefaultInboxSlug,
  inboxSlugContainsEmailToken,
  isReservedInboxSlug,
  normalizeEmail as normalizeSharedEmail,
  normalizeInboxSlug,
} from '../../../shared/inbox-slug';
import {
  CONTACT_REQUEST_STATUSES,
  CONTACT_ALLOWLIST_KINDS,
  DEFAULT_PUBLIC_CONTACT_POLICY,
  MAX_PUBLIC_DESCRIPTION_CHARS,
} from '../../../shared/contact-policy';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
} from '../../../shared/message-format';

import {
  MAX_MESSAGE_ALGORITHM_CHARS,
  MAX_MESSAGE_IV_HEX_CHARS,
  MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS,
  MAX_MESSAGE_SIGNATURE_HEX_CHARS,
  MAX_MESSAGE_VERSION_CHARS,
  MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
  MAX_WRAPPED_SECRET_IV_HEX_CHARS,
} from '../../../shared/message-limits';
import {
  TRUSTED_OIDC_AUDIENCES,
  TRUSTED_OIDC_ISSUERS,
} from '../../../shared/generated-oidc-config';
import { isClientGeneratedThreadId } from '../../../shared/inbox-state';
import {
  MAX_DEVICE_ID_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_THREAD_TITLE_CHARS,
  MAX_CHANNEL_SLUG_CHARS,
  MAX_CHANNEL_TITLE_CHARS,
  MAX_CHANNEL_DESCRIPTION_CHARS,
  MAX_PUBLIC_KEY_CHARS,
  MAX_DEVICE_LABEL_CHARS,
  MAX_DEVICE_PLATFORM_CHARS,
  MAX_DEVICE_STATUS_CHARS,
  MAX_DEVICE_VERIFICATION_CODE_HASH_CHARS,
  MAX_DEVICE_BUNDLE_ALGORITHM_CHARS,
  MAX_DEVICE_BUNDLE_CIPHERTEXT_HEX_CHARS,
  MAX_MASUMI_NETWORK_CHARS,
  MAX_MASUMI_REGISTRATION_ID_CHARS,
  MAX_MASUMI_AGENT_IDENTIFIER_CHARS,
  MAX_MASUMI_REGISTRATION_STATE_CHARS,
  MAX_CONTACT_REQUEST_STATUS_CHARS,
  MAX_CONTACT_ALLOWLIST_KIND_CHARS,
  MAX_THREAD_FANOUT,
  DEFAULT_DEVICE_ENCRYPTION_ALGORITHM,
  HEX_PATTERN,
  CHANNEL_ADMIN_RATE_WINDOW_MS,
  CHANNEL_ADMIN_RATE_MAX_PER_WINDOW,
  DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS,
  RATE_LIMIT_REPORT_RETENTION_MS,
  THREAD_INVITE_STATUSES,
  CHANNEL_ACCESS_MODES,
  CHANNEL_PERMISSIONS,
  CHANNEL_JOIN_REQUEST_STATUSES,
  MAX_CHANNEL_RECENT_PUBLIC_MESSAGES,
} from './constants';
import type { DeviceKeyBundleExpiryModeValue } from './constants';
import type {
  OidcIdentityClaims,
  ModuleCtx,
  InboxRow,
  ActorRow,
  DeviceKeyBundleRow,
  InboxAuthLeaseRow,
  RateLimitRow,
  RateLimitReportRow,
  ThreadRow,
  ThreadParticipantRow,
  MessageRow,
  ChannelRow,
  ChannelMessageRecordRow,
  PublicRecentChannelMessageRecordRow,
  ThreadInviteRow,
  ReadDbCtx,
  ReadAuthCtx,
  MaybeReadAuthCtx,
  DeviceReadDbCtx,
  DeviceReadAuthCtx,
} from './types';

export function normalizeEmail(value: string): string {
  return requireNonEmpty(normalizeSharedEmail(value), 'email');
}

export function normalizeCustomInboxSlug(value: string, normalizedEmail: string): string {
  const normalizedSlug = requireNonEmpty(normalizeInboxSlug(value), 'slug');
  if (isReservedInboxSlug(normalizedSlug)) {
    throw new SenderError('slug is reserved');
  }
  if (inboxSlugContainsEmailToken(normalizedSlug, normalizedEmail)) {
    throw new SenderError('slug must not contain the email token');
  }
  return normalizedSlug;
}

export function normalizeExplicitDefaultInboxSlug(value: string): string {
  const normalizedSlug = requireNonEmpty(normalizeInboxSlug(value), 'defaultSlug');
  if (isReservedInboxSlug(normalizedSlug)) {
    throw new SenderError('defaultSlug is reserved');
  }
  return normalizedSlug;
}

export function buildPublicIdentity(slug: string): string {
  return requireNonEmpty(normalizeInboxSlug(slug), 'publicIdentity');
}

export function normalizePublicIdentity(value: string): string {
  return requireNonEmpty(normalizeInboxSlug(value), 'publicIdentity');
}

export function buildDefaultSlug(ctx: ModuleCtx, normalizedEmail: string): string {
  try {
    return buildPreferredDefaultInboxSlug(normalizedEmail, slug => Boolean(getActorBySlug(ctx, slug)));
  } catch (error) {
    throw new SenderError(
      error instanceof Error ? error.message : 'Unable to generate an available default slug'
    );
  }
}

export function requireAvailableSlug(
  ctx: ModuleCtx,
  slug: string,
  options?: { allowActorId?: bigint }
): string {
  const existing = getActorBySlug(ctx, slug);
  if (existing && existing.id !== options?.allowActorId) {
    throw new SenderError('slug is already registered');
  }
  return slug;
}

export function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SenderError(`${field} is required`);
  return trimmed;
}

export function requireMaxLength(value: string, maxLength: number, field: string): string {
  if (value.length > maxLength) {
    throw new SenderError(`${field} must be ${maxLength.toString()} characters or fewer`);
  }
  return value;
}

export function requireHexMaxLength(value: string, maxLength: number, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, maxLength, field);
  if (normalized.length % 2 !== 0 || !HEX_PATTERN.test(normalized)) {
    throw new SenderError(`${field} must be even-length hexadecimal`);
  }
  return normalized;
}

export function normalizePublicKey(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, MAX_PUBLIC_KEY_CHARS, field);
  return normalized;
}

export function normalizeOptionalDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DISPLAY_NAME_CHARS, 'displayName');
  return normalized;
}

export function normalizeOptionalThreadTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_THREAD_TITLE_CHARS, 'title');
  return normalized;
}

export function normalizeChannelSlug(value: string): string {
  const normalizedSlug = requireNonEmpty(normalizeInboxSlug(value), 'channelSlug');
  requireMaxLength(normalizedSlug, MAX_CHANNEL_SLUG_CHARS, 'channelSlug');
  if (isReservedInboxSlug(normalizedSlug)) {
    throw new SenderError('channelSlug is reserved');
  }
  return normalizedSlug;
}

export function normalizeOptionalChannelTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_CHANNEL_TITLE_CHARS, 'title');
  return normalized;
}

export function normalizeOptionalChannelDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_CHANNEL_DESCRIPTION_CHARS, 'description');
  return normalized;
}

export function requireValidEmail(value: string, field: string): string {
  const normalized = normalizeEmail(value);
  if (!normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    throw new SenderError(`${field} must be a valid email`);
  }
  return normalized;
}

export function compareTimestamp(left: Timestamp, right: Timestamp): number {
  if (left.microsSinceUnixEpoch < right.microsSinceUnixEpoch) return -1;
  if (left.microsSinceUnixEpoch > right.microsSinceUnixEpoch) return 1;
  return 0;
}

export function isTimestampExpired(expiresAt: Timestamp, now: Timestamp): boolean {
  return compareTimestamp(expiresAt, now) <= 0;
}

export function durationMillisecondsToMicros(milliseconds: number): bigint {
  return BigInt(milliseconds) * 1000n;
}

export function timestampPlusMilliseconds(value: Timestamp, milliseconds: number): Timestamp {
  return new Timestamp(
    value.microsSinceUnixEpoch + durationMillisecondsToMicros(milliseconds)
  );
}

export function requireClaimableDeviceKeyBundleExpiry(now: Timestamp, expiresAt: Timestamp): void {
  if (compareTimestamp(expiresAt, now) <= 0) {
    throw new SenderError('Device key bundle expiresAt must be in the future');
  }

  const latestAllowedExpiry = timestampPlusMilliseconds(
    now,
    DEVICE_KEY_BUNDLE_MAX_LIFETIME_MS
  );
  if (compareTimestamp(expiresAt, latestAllowedExpiry) > 0) {
    throw new SenderError('Device key bundle expiresAt is too far in the future');
  }
}

export function cancelRateLimitCleanupSchedules(
  dbCtx: { db: ModuleCtx['db'] },
  bucketKey: string
): void {
  for (const cleanup of Array.from(
    dbCtx.db.rateLimitCleanup.rate_limit_cleanup_bucket_key.filter(bucketKey)
  )) {
    dbCtx.db.rateLimitCleanup.delete(cleanup);
  }
}

export function scheduleRateLimitCleanup(
  dbCtx: { db: ModuleCtx['db'] },
  bucketKey: string,
  expiresAt: Timestamp,
  now: Timestamp
): void {
  cancelRateLimitCleanupSchedules(dbCtx, bucketKey);
  dbCtx.db.rateLimitCleanup.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
    bucketKey,
    expiresAt,
    createdAt: now,
  });
}

export function buildRateLimitReportKey(
  bucketKey: string,
  windowStart: Timestamp,
  windowExpiresAt: Timestamp
): string {
  return `${bucketKey}\u0000${windowStart.microsSinceUnixEpoch.toString()}\u0000${windowExpiresAt.microsSinceUnixEpoch.toString()}`;
}

export function cancelRateLimitReportCleanupSchedules(
  dbCtx: { db: ModuleCtx['db'] },
  reportId: bigint
): void {
  for (const cleanup of Array.from(
    dbCtx.db.rateLimitReportCleanup.rate_limit_report_cleanup_report_id.filter(reportId)
  )) {
    dbCtx.db.rateLimitReportCleanup.delete(cleanup);
  }
}

export function scheduleRateLimitReportCleanup(
  dbCtx: { db: ModuleCtx['db'] },
  report: RateLimitReportRow,
  now: Timestamp
): void {
  cancelRateLimitReportCleanupSchedules(dbCtx, report.id);
  dbCtx.db.rateLimitReportCleanup.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(report.expiresAt.microsSinceUnixEpoch),
    reportId: report.id,
    expiresAt: report.expiresAt,
    createdAt: now,
  });
}

export function reportRateLimitBucket(
  dbCtx: { db: ModuleCtx['db'] },
  bucket: RateLimitRow,
  reportedAt: Timestamp
): void {
  if (bucket.limitedCount === 0n) {
    return;
  }

  const reportKey = buildRateLimitReportKey(
    bucket.bucketKey,
    bucket.windowStart,
    bucket.expiresAt
  );
  const reportExpiresAt = timestampPlusMilliseconds(reportedAt, RATE_LIMIT_REPORT_RETENTION_MS);
  const existing = dbCtx.db.rateLimitReport.reportKey.find(reportKey);
  const report = existing
    ? dbCtx.db.rateLimitReport.id.update({
        ...existing,
        allowedCount: bucket.count,
        limitedCount: bucket.limitedCount,
        firstLimitedAt: bucket.firstLimitedAt,
        lastLimitedAt: bucket.lastLimitedAt,
        reportedAt,
        expiresAt: reportExpiresAt,
      })
    : dbCtx.db.rateLimitReport.insert({
        id: 0n,
        reportKey,
        bucketKey: bucket.bucketKey,
        action: bucket.action,
        ownerIdentity: bucket.ownerIdentity,
        windowStart: bucket.windowStart,
        windowExpiresAt: bucket.expiresAt,
        allowedCount: bucket.count,
        limitedCount: bucket.limitedCount,
        firstLimitedAt: bucket.firstLimitedAt,
        lastLimitedAt: bucket.lastLimitedAt,
        reportedAt,
        expiresAt: reportExpiresAt,
      });

  scheduleRateLimitReportCleanup(dbCtx, report, reportedAt);
}

export function enforceRateLimit(
  dbCtx: { db: ModuleCtx['db'] },
  params: {
    bucketKey: string;
    action: string;
    ownerIdentity: ModuleCtx['sender'];
    now: Timestamp;
    windowMs: number;
    maxCount: bigint;
  }
): boolean {
  const { bucketKey, action, ownerIdentity, now, windowMs, maxCount } = params;
  const existing = dbCtx.db.rateLimit.bucketKey.find(bucketKey);
  const expiresAt = timestampPlusMilliseconds(now, windowMs);
  if (!existing) {
    dbCtx.db.rateLimit.insert({
      id: 0n,
      bucketKey,
      action,
      ownerIdentity,
      windowStart: now,
      expiresAt,
      count: 1n,
      limitedCount: 0n,
      firstLimitedAt: undefined,
      lastLimitedAt: undefined,
      updatedAt: now,
    });
    scheduleRateLimitCleanup(dbCtx, bucketKey, expiresAt, now);
    return true;
  }

  if (isTimestampExpired(existing.expiresAt, now)) {
    reportRateLimitBucket(dbCtx, existing, now);
    dbCtx.db.rateLimit.id.update({
      ...existing,
      action,
      ownerIdentity,
      windowStart: now,
      expiresAt,
      count: 1n,
      limitedCount: 0n,
      firstLimitedAt: undefined,
      lastLimitedAt: undefined,
      updatedAt: now,
    });
    scheduleRateLimitCleanup(dbCtx, bucketKey, expiresAt, now);
    return true;
  }

  if (existing.count >= maxCount) {
    dbCtx.db.rateLimit.id.update({
      ...existing,
      action,
      ownerIdentity,
      limitedCount: existing.limitedCount + 1n,
      firstLimitedAt: existing.firstLimitedAt ?? now,
      lastLimitedAt: now,
      updatedAt: now,
    });
    return false;
  }
  dbCtx.db.rateLimit.id.update({
    ...existing,
    action,
    ownerIdentity,
    count: existing.count + 1n,
    updatedAt: now,
  });
  return true;
}

export function enforceChannelAdminRateLimit(ctx: ModuleCtx, channelId: bigint): void {
  const allowed = enforceRateLimit(ctx, {
    bucketKey: `channel_admin:${ctx.sender.toHexString()}:${channelId.toString()}`,
    action: 'channel_admin',
    ownerIdentity: ctx.sender,
    now: ctx.timestamp,
    windowMs: CHANNEL_ADMIN_RATE_WINDOW_MS,
    maxCount: CHANNEL_ADMIN_RATE_MAX_PER_WINDOW,
  });
  if (!allowed) {
    throw new SenderError('Too many channel admin operations; try again later');
  }
}

export function normalizeDeviceId(value: string): string {
  const normalized = requireNonEmpty(value, 'deviceId');
  requireMaxLength(normalized, MAX_DEVICE_ID_CHARS, 'deviceId');
  return normalized;
}

export function normalizeOptionalDeviceLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DEVICE_LABEL_CHARS, 'label');
  return normalized;
}

export function normalizeOptionalPlatform(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_DEVICE_PLATFORM_CHARS, 'platform');
  return normalized;
}

export function normalizeDeviceStatus(value: string): string {
  const normalized = requireNonEmpty(value, 'status');
  requireMaxLength(normalized, MAX_DEVICE_STATUS_CHARS, 'status');
  return normalized;
}

export function normalizeAlgorithm(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  requireMaxLength(normalized, MAX_MESSAGE_ALGORITHM_CHARS, field);
  return normalized;
}

export function normalizeChannelPlaintext(value: string): string {
  if (!value.trim()) {
    throw new SenderError('plaintext is required');
  }
  requireMaxLength(value, MAX_MESSAGE_SERIALIZED_PAYLOAD_CHARS, 'plaintext');
  return value;
}

export function normalizeOptionalAlgorithm(
  value: string | undefined,
  fallback: string,
  field: string
): string {
  return normalizeAlgorithm(value?.trim() ? value.trim() : fallback, field);
}

export function normalizeOptionalMasumiNetwork(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_MASUMI_NETWORK_CHARS, 'masumiRegistrationNetwork');
  return normalized;
}

export function normalizeOptionalMasumiRegistrationId(
  value: string | undefined,
  field: 'masumiInboxAgentId' | 'masumiAgentIdentifier'
): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(
    normalized,
    field === 'masumiInboxAgentId'
      ? MAX_MASUMI_REGISTRATION_ID_CHARS
      : MAX_MASUMI_AGENT_IDENTIFIER_CHARS,
    field
  );
  return normalized;
}

export function normalizeOptionalMasumiRegistrationState(
  value: string | undefined
): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_MASUMI_REGISTRATION_STATE_CHARS, 'masumiRegistrationState');
  return normalized;
}

export function normalizeOptionalPublicDescription(value: string | undefined): string | undefined {
  const normalized = value?.trim() ? value.trim() : undefined;
  if (!normalized) return undefined;
  requireMaxLength(normalized, MAX_PUBLIC_DESCRIPTION_CHARS, 'publicDescription');
  return normalized;
}

export function normalizeContactRequestStatus(value: string): { tag: (typeof CONTACT_REQUEST_STATUSES)[number] } {
  const normalized = requireNonEmpty(value, 'contactRequestStatus');
  requireMaxLength(normalized, MAX_CONTACT_REQUEST_STATUS_CHARS, 'contactRequestStatus');
  if (!CONTACT_REQUEST_STATUSES.includes(normalized as (typeof CONTACT_REQUEST_STATUSES)[number])) {
    throw new SenderError('contactRequestStatus is invalid');
  }
  return { tag: normalized as (typeof CONTACT_REQUEST_STATUSES)[number] };
}

export function normalizeContactAllowlistKind(value: string): { tag: (typeof CONTACT_ALLOWLIST_KINDS)[number] } {
  const normalized = requireNonEmpty(value, 'contactAllowlistKind');
  requireMaxLength(normalized, MAX_CONTACT_ALLOWLIST_KIND_CHARS, 'contactAllowlistKind');
  if (!CONTACT_ALLOWLIST_KINDS.includes(normalized as (typeof CONTACT_ALLOWLIST_KINDS)[number])) {
    throw new SenderError('contactAllowlistKind is invalid');
  }
  return { tag: normalized as (typeof CONTACT_ALLOWLIST_KINDS)[number] };
}

export function normalizeThreadInviteStatus(value: string) {
  const normalized = requireNonEmpty(value, 'threadInviteStatus');
  requireMaxLength(normalized, MAX_CONTACT_REQUEST_STATUS_CHARS, 'threadInviteStatus');
  if (!THREAD_INVITE_STATUSES.includes(normalized as (typeof THREAD_INVITE_STATUSES)[number])) {
    throw new SenderError('threadInviteStatus is invalid');
  }
  return normalized as (typeof THREAD_INVITE_STATUSES)[number];
}

export function normalizeChannelAccessMode(value: string): (typeof CHANNEL_ACCESS_MODES)[number] {
  const normalized = requireNonEmpty(value, 'accessMode');
  requireMaxLength(normalized, MAX_DEVICE_STATUS_CHARS, 'accessMode');
  if (!CHANNEL_ACCESS_MODES.includes(normalized as (typeof CHANNEL_ACCESS_MODES)[number])) {
    throw new SenderError('accessMode is invalid');
  }
  return normalized as (typeof CHANNEL_ACCESS_MODES)[number];
}

export function normalizeChannelPermission(
  value: string,
  options?: { allowAdmin?: boolean }
): (typeof CHANNEL_PERMISSIONS)[number] {
  const normalized = requireNonEmpty(value, 'permission');
  requireMaxLength(normalized, MAX_DEVICE_STATUS_CHARS, 'permission');
  if (!CHANNEL_PERMISSIONS.includes(normalized as (typeof CHANNEL_PERMISSIONS)[number])) {
    throw new SenderError('permission is invalid');
  }
  if (normalized === 'admin' && options?.allowAdmin === false) {
    throw new SenderError('permission cannot be admin for this action');
  }
  return normalized as (typeof CHANNEL_PERMISSIONS)[number];
}

export function normalizeChannelJoinRequestStatus(
  value: string
): (typeof CHANNEL_JOIN_REQUEST_STATUSES)[number] {
  const normalized = requireNonEmpty(value, 'channelJoinRequestStatus');
  requireMaxLength(normalized, MAX_CONTACT_REQUEST_STATUS_CHARS, 'channelJoinRequestStatus');
  if (
    !CHANNEL_JOIN_REQUEST_STATUSES.includes(
      normalized as (typeof CHANNEL_JOIN_REQUEST_STATUSES)[number]
    )
  ) {
    throw new SenderError('channelJoinRequestStatus is invalid');
  }
  return normalized as (typeof CHANNEL_JOIN_REQUEST_STATUSES)[number];
}

export function requireMaxArrayLength<T>(values: readonly T[], maxLength: number, field: string): void {
  if (values.length > maxLength) {
    throw new SenderError(`${field} may include at most ${maxLength.toString()} items`);
  }
}

export function normalizeVerificationCodeHash(value: string): string {
  const normalized = requireNonEmpty(value, 'verificationCodeHash');
  requireMaxLength(
    normalized,
    MAX_DEVICE_VERIFICATION_CODE_HASH_CHARS,
    'verificationCodeHash'
  );
  return normalized;
}

export function readStringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readBooleanClaim(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

export function readNumericClaim(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function requireOidcIdentityClaims(ctx: ReadAuthCtx): OidcIdentityClaims {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) {
    throw new SenderError('OIDC authentication is required before this action');
  }

  if (!TRUSTED_OIDC_ISSUERS.has(jwt.issuer)) {
    throw new SenderError('Unauthorized issuer');
  }

  if (!jwt.audience.some(audience => TRUSTED_OIDC_AUDIENCES.has(audience as never))) {
    throw new SenderError('Unauthorized audience');
  }

  const payload = jwt.fullPayload as Record<string, unknown>;
  const displayEmail = requireNonEmpty(
    readStringClaim(payload, 'email') ?? '',
    'jwt.email'
  );
  if (!readBooleanClaim(payload, 'email_verified')) {
    throw new SenderError('OIDC token requires email_verified=true');
  }

  const exp = readNumericClaim(payload, 'exp');
  if (exp === undefined) {
    throw new SenderError('OIDC token exp claim is required');
  }
  const expiresAt = Timestamp.fromDate(new Date(exp * 1000));
  if (isTimestampExpired(expiresAt, ctx.timestamp)) {
    throw new SenderError('OIDC token is expired');
  }

  return {
    normalizedEmail: requireValidEmail(displayEmail, 'jwt.email'),
    displayEmail,
    subject: requireNonEmpty(jwt.subject, 'jwt.sub'),
    issuer: requireNonEmpty(jwt.issuer, 'jwt.iss'),
    sessionId: readStringClaim(payload, 'sid'),
    jwtId: readStringClaim(payload, 'jti'),
    displayName: readStringClaim(payload, 'name'),
    expiresAt,
  };
}

export function getInboxes(ctx: ReadDbCtx) {
  return Array.from(ctx.db.inbox.iter()) as Array<ReturnType<typeof getRequiredInboxById>>;
}

export function getActors(ctx: ReadDbCtx) {
  return Array.from(ctx.db.agent.iter()) as Array<ReturnType<typeof getRequiredActorByDbId>>;
}

export function getDevices(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.device.iter()) as Array<ReturnType<typeof getRequiredDeviceByRowId>>;
}

export function getDevicesByInboxId(ctx: DeviceReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.device.device_inbox_id.filter(inboxId));
}

export function getDeviceShareRequests(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.deviceShareRequest.iter()) as Array<
    ReturnType<typeof getRequiredDeviceShareRequestByRowId>
  >;
}

export function getDeviceKeyBundles(ctx: DeviceReadDbCtx) {
  return Array.from(ctx.db.deviceKeyBundle.iter()) as Array<
    ReturnType<typeof getRequiredDeviceKeyBundleByRowId>
  >;
}

export function getContactAllowlistEntriesByInboxId(ctx: ReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.contactAllowlistEntry.contact_allowlist_entry_inbox_id.filter(inboxId));
}

export function firstMatchingRow<Row>(rows: Iterable<Row>): Row | null {
  for (const row of rows) {
    return row;
  }
  return null;
}

export function dedupeRowsById<Row extends { id: bigint }>(rows: Iterable<Row>): Row[] {
  const deduped = new Map<string, Row>();
  for (const row of rows) {
    deduped.set(row.id.toString(), row);
  }
  return Array.from(deduped.values());
}

export function getInboxByNormalizedEmail(ctx: ReadDbCtx, normalizedEmail: string) {
  return ctx.db.inbox.normalizedEmail.find(normalizedEmail);
}

export function getInboxByOwnerIdentity(ctx: ReadDbCtx) {
  return ctx.db.inbox.ownerIdentity.find(ctx.sender);
}

export function buildInboxAuthIdentityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

export function requireFutureOidcExpiry(ctx: ModuleCtx, oidcClaims: OidcIdentityClaims): Timestamp {
  if (!oidcClaims.expiresAt) {
    throw new SenderError('OIDC token exp claim is required');
  }
  if (isTimestampExpired(oidcClaims.expiresAt, ctx.timestamp)) {
    throw new SenderError('OIDC token is expired');
  }
  return oidcClaims.expiresAt;
}

export function cancelInboxAuthLeaseExpirySchedules(ctx: ModuleCtx, leaseId: bigint) {
  for (const expiry of Array.from(
    ctx.db.inboxAuthLeaseExpiry.inbox_auth_lease_expiry_lease_id.filter(leaseId)
  )) {
    ctx.db.inboxAuthLeaseExpiry.delete(expiry);
  }
}

export function scheduleInboxAuthLeaseExpiry(ctx: ModuleCtx, lease: InboxAuthLeaseRow) {
  cancelInboxAuthLeaseExpirySchedules(ctx, lease.id);
  ctx.db.inboxAuthLeaseExpiry.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(lease.expiresAt.microsSinceUnixEpoch),
    leaseId: lease.id,
    ownerIdentity: lease.ownerIdentity,
    expiresAt: lease.expiresAt,
    createdAt: ctx.timestamp,
  });
}

export function deactivateInboxAuthLease(ctx: ModuleCtx, lease: InboxAuthLeaseRow) {
  cancelInboxAuthLeaseExpirySchedules(ctx, lease.id);
  if (!lease.active) {
    return;
  }
  ctx.db.inboxAuthLease.id.update({
    ...lease,
    active: false,
    updatedAt: ctx.timestamp,
  });
}

export function deactivateSenderInboxAuthLease(ctx: ModuleCtx) {
  const lease = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);
  if (!lease) {
    return;
  }
  deactivateInboxAuthLease(ctx, lease);
}

export const EXPECTED_INBOX_AUTH_LEASE_REFRESH_ERRORS = new Set([
  'OIDC authentication is required before this action',
  'Unauthorized issuer',
  'Unauthorized audience',
  'jwt.email is required',
  'jwt.email must be a valid email',
  'jwt.sub is required',
  'jwt.iss is required',
  'OIDC token requires email_verified=true',
  'OIDC token exp claim is required',
  'OIDC token is expired',
  'Current OIDC session is not authorized for this inbox',
  'Current OIDC session email does not match this inbox namespace',
  'Inbox auth verification is required before this action',
]);

export function isExpectedInboxAuthLeaseRefreshError(error: unknown): boolean {
  return (
    error instanceof SenderError && EXPECTED_INBOX_AUTH_LEASE_REFRESH_ERRORS.has(error.message)
  );
}

export function upsertInboxAuthLease(
  ctx: ModuleCtx,
  inbox: InboxRow,
  oidcClaims: OidcIdentityClaims
) {
  if (inbox.authIssuer !== oidcClaims.issuer || inbox.authSubject !== oidcClaims.subject) {
    throw new SenderError('Current OIDC session is not authorized for this inbox');
  }
  if (inbox.normalizedEmail !== oidcClaims.normalizedEmail) {
    throw new SenderError('Current OIDC session email does not match this inbox namespace');
  }

  const expiresAt = requireFutureOidcExpiry(ctx, oidcClaims);
  const authIdentityKey = buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject);
  const existing = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);

  const lease = existing
    ? ctx.db.inboxAuthLease.id.update({
        ...existing,
        inboxId: inbox.id,
        authIdentityKey,
        normalizedEmail: inbox.normalizedEmail,
        authIssuer: oidcClaims.issuer,
        authSubject: oidcClaims.subject,
        expiresAt,
        active: true,
        updatedAt: ctx.timestamp,
      })
    : ctx.db.inboxAuthLease.insert({
        id: 0n,
        ownerIdentity: ctx.sender,
        inboxId: inbox.id,
        authIdentityKey,
        normalizedEmail: inbox.normalizedEmail,
        authIssuer: oidcClaims.issuer,
        authSubject: oidcClaims.subject,
        expiresAt,
        active: true,
        updatedAt: ctx.timestamp,
      });

  if (!isTimestampExpired(lease.expiresAt, ctx.timestamp)) {
    scheduleInboxAuthLeaseExpiry(ctx, lease);
    return lease;
  }
  throw new SenderError('OIDC token is expired');
}

export function refreshInboxAuthLeaseForInbox(ctx: ModuleCtx, inbox: InboxRow) {
  const oidcClaims = requireOidcIdentityClaims(ctx);
  requireInboxMatchesOidcClaims(inbox, oidcClaims);
  requireVerifiedInbox(inbox);
  const lease = upsertInboxAuthLease(ctx, inbox, oidcClaims);
  reconcileDeviceKeyBundleExpiryState(ctx, inbox.id, ctx.timestamp);
  return lease;
}

export function getActiveInboxAuthLease(ctx: ReadDbCtx, inbox: InboxRow) {
  const lease = ctx.db.inboxAuthLease.ownerIdentity.find(ctx.sender);
  if (!lease || !lease.active) {
    return null;
  }
  if (lease.inboxId !== inbox.id) {
    return null;
  }
  // Expiry is enforced by the scheduled `expireInboxAuthLease` reducer flipping
  // `active = false`. Views cannot access wall-clock time (no `ctx.timestamp`)
  // and must remain deterministic — do not call `Timestamp.now()` here.
  if (
    lease.authIdentityKey !== buildInboxAuthIdentityKey(inbox.authIssuer, inbox.authSubject) ||
    lease.normalizedEmail !== inbox.normalizedEmail ||
    lease.authIssuer !== inbox.authIssuer ||
    lease.authSubject !== inbox.authSubject
  ) {
    return null;
  }
  return lease;
}

export function buildThreadParticipantKey(threadId: bigint, agentDbId: bigint): string {
  return `${threadId.toString()}:${agentDbId.toString()}`;
}

export function buildMessageThreadSeqKey(threadId: bigint, threadSeq: bigint): string {
  return `${threadId.toString()}:${threadSeq.toString()}`;
}

export function buildThreadReadStateKey(threadId: bigint, agentDbId: bigint): string {
  return `${threadId.toString()}:${agentDbId.toString()}`;
}

export function buildThreadInviteKey(threadId: bigint, inviteeAgentDbId: bigint): string {
  return `${threadId.toString()}:${inviteeAgentDbId.toString()}`;
}

export function buildThreadSecretEnvelopeKey(
  threadId: bigint,
  membershipVersion: bigint,
  secretVersion: string,
  senderAgentDbId: bigint,
  recipientAgentDbId: bigint
): string {
  return `${threadId.toString()}:${membershipVersion.toString()}:${secretVersion}:${senderAgentDbId.toString()}:${recipientAgentDbId.toString()}`;
}

export function buildChannelMemberKey(channelId: bigint, agentDbId: bigint): string {
  return `${channelId.toString()}:${agentDbId.toString()}`;
}

export function buildChannelJoinRequestKey(channelId: bigint, requesterAgentDbId: bigint): string {
  return `${channelId.toString()}:${requesterAgentDbId.toString()}`;
}

export function buildChannelMessageSeqKey(channelId: bigint, channelSeq: bigint): string {
  return `${channelId.toString()}:${channelSeq.toString()}`;
}

export function buildSenderSecretVisibilityKey(
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
): string {
  return `${membershipVersion.toString()}:${senderAgentDbId.toString()}:${secretVersion}`;
}

export function buildAgentKeyBundleKey(
  agentDbId: bigint,
  encryptionKeyVersion: string,
  signingKeyVersion: string
): string {
  return `${agentDbId.toString()}:${encryptionKeyVersion}:${signingKeyVersion}`;
}

export function buildContactAllowlistEntryKey(
  inboxId: bigint,
  kind: string,
  agentPublicIdentity: string | undefined,
  normalizedEmail: string | undefined
): string {
  return `${inboxId.toString()}:${kind}:${agentPublicIdentity ?? ''}:${normalizedEmail ?? ''}`;
}

export function buildDeviceKey(inboxId: bigint, deviceId: string): string {
  return `${inboxId.toString()}:${deviceId.length.toString()}:${deviceId}`;
}

export function getDefaultInboxIdentity(ctx: ReadDbCtx, inboxId: bigint) {
  return getActorsByInboxId(ctx, inboxId).find(actor => actor.isDefault);
}

export function getActorBySlug(ctx: ReadDbCtx, slug: string) {
  return ctx.db.agent.slug.find(slug);
}

export function getActorsByInboxId(ctx: ReadDbCtx, inboxId: bigint) {
  return Array.from(ctx.db.agent.agent_inbox_id.filter(inboxId));
}

export function getOwnActorIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  return new Set(getActorsByInboxId(ctx, inboxId).map(actor => actor.id));
}

export function getPublicActorsByNormalizedEmail(ctx: ReadDbCtx, normalizedEmail: string) {
  const inbox = getInboxByNormalizedEmail(ctx, normalizedEmail);
  if (!inbox) {
    return [];
  }

  return getActorsByInboxId(ctx, inbox.id)
    .filter(actor => actor.publicLinkedEmailEnabled)
    .sort(comparePublishedActorRows);
}

export function getActorByPublicIdentity(ctx: ReadDbCtx, publicIdentity: string) {
  return ctx.db.agent.publicIdentity.find(publicIdentity);
}

export function comparePublishedActorRows(
  left: ReturnType<typeof getRequiredActorByDbId>,
  right: ReturnType<typeof getRequiredActorByDbId>
): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  if (left.slug < right.slug) return -1;
  if (left.slug > right.slug) return 1;
  return 0;
}

export function toPublishedAgentLookupRow(actor: ReturnType<typeof getRequiredActorByDbId>) {
  return {
    slug: actor.slug,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    displayName: actor.displayName,
      agentIdentifier: actor.masumiAgentIdentifier,
      encryptionKeyVersion: actor.currentEncryptionKeyVersion,
      encryptionAlgorithm: actor.currentEncryptionAlgorithm,
      encryptionPublicKey: actor.currentEncryptionPublicKey,
      signingKeyVersion: actor.currentSigningKeyVersion,
      signingAlgorithm: actor.currentSigningAlgorithm,
      signingPublicKey: actor.currentSigningPublicKey,
  };
}

export function getActorPublishedMessageCapabilities(actor: ReturnType<typeof getRequiredActorByDbId>) {
  if (!actor.supportedMessageContentTypes || !actor.supportedMessageHeaderNames) {
    return buildLegacyPublicMessageCapabilities();
  }

  return buildPublicMessageCapabilities({
    allowAllContentTypes:
      actor.allowAllMessageContentTypes ?? (actor.supportedMessageContentTypes.length === 0),
    allowAllHeaders:
      actor.allowAllMessageHeaders ?? (actor.supportedMessageHeaderNames.length === 0),
    supportedContentTypes: actor.supportedMessageContentTypes,
    supportedHeaders: actor.supportedMessageHeaderNames,
  });
}

export function toPublishedPublicHeaderCapabilityRow(capability: ReturnType<
  typeof getActorPublishedMessageCapabilities
>['supportedHeaders'][number]) {
  return {
    name: capability.name,
    required: capability.required ?? undefined,
    allowMultiple: capability.allowMultiple ?? undefined,
    sensitive: capability.sensitive ?? undefined,
    allowedPrefixes: capability.allowedPrefixes ?? undefined,
  };
}

export function toPublishedPublicRouteRow(
  actor: ReturnType<typeof getRequiredActorByDbId>,
  inbox: ReturnType<typeof getRequiredInboxById>
) {
  const capabilities = getActorPublishedMessageCapabilities(actor);
  return {
    agentIdentifier: actor.masumiAgentIdentifier,
    linkedEmail: actor.publicLinkedEmailEnabled ? inbox.displayEmail : undefined,
      description: actor.publicDescription,
      encryptionKeyVersion: actor.currentEncryptionKeyVersion,
      encryptionAlgorithm: actor.currentEncryptionAlgorithm,
      encryptionPublicKey: actor.currentEncryptionPublicKey,
      signingKeyVersion: actor.currentSigningKeyVersion,
      signingAlgorithm: actor.currentSigningAlgorithm,
      signingPublicKey: actor.currentSigningPublicKey,
    allowAllContentTypes: capabilities.allowAllContentTypes,
    allowAllHeaders: capabilities.allowAllHeaders,
    supportedContentTypes: capabilities.supportedContentTypes,
    supportedHeaders: capabilities.supportedHeaders.map(toPublishedPublicHeaderCapabilityRow),
    contactPolicy: {
      ...DEFAULT_PUBLIC_CONTACT_POLICY,
      allowlistKinds: [...DEFAULT_PUBLIC_CONTACT_POLICY.allowlistKinds],
    },
  };
}

export function getDeviceByInboxDeviceId(ctx: DeviceReadDbCtx, inboxId: bigint, deviceId: string) {
  return ctx.db.device.uniqueKey.find(buildDeviceKey(inboxId, deviceId));
}

export function getRequiredInboxById(ctx: ReadDbCtx, inboxId: bigint) {
  const inbox = ctx.db.inbox.id.find(inboxId);
  if (!inbox) {
    throw new SenderError('Inbox was not found');
  }
  return inbox;
}

export function getRequiredActorByDbId(ctx: ReadDbCtx, agentDbId: bigint) {
  const actor = ctx.db.agent.id.find(agentDbId);
  if (!actor) {
    throw new SenderError('Actor was not found');
  }
  return actor;
}

export function getRequiredActorByPublicIdentity(ctx: ReadDbCtx, publicIdentity: string) {
  const actor = getActorByPublicIdentity(ctx, normalizePublicIdentity(publicIdentity));
  if (!actor) {
    throw new SenderError('Actor was not found');
  }
  return actor;
}

export function getRequiredDeviceByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const device = ctx.db.device.id.find(rowId);
  if (!device) {
    throw new SenderError('Device was not found');
  }
  return device;
}

export function getRequiredDeviceShareRequestByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const request = ctx.db.deviceShareRequest.id.find(rowId);
  if (!request) {
    throw new SenderError('Device share request was not found');
  }
  return request;
}

export function getRequiredDeviceKeyBundleByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const bundle = ctx.db.deviceKeyBundle.id.find(rowId);
  if (!bundle) {
    throw new SenderError('Device key share bundle was not found');
  }
  return bundle;
}

export function getRequiredContactRequestByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const request = ctx.db.contactRequest.id.find(rowId);
  if (!request) {
    throw new SenderError('Contact request was not found');
  }
  return request;
}

export function getRequiredContactAllowlistEntryByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const entry = ctx.db.contactAllowlistEntry.id.find(rowId);
  if (!entry) {
    throw new SenderError('Contact allowlist entry was not found');
  }
  return entry;
}

export function getRequiredThreadInviteByRowId(ctx: ReadDbCtx, rowId: bigint) {
  const invite = ctx.db.threadInvite.id.find(rowId);
  if (!invite) {
    throw new SenderError('Thread invite was not found');
  }
  return invite;
}

export function getChannelBySlug(ctx: ReadDbCtx, slug: string) {
  return ctx.db.channel.slug.find(normalizeChannelSlug(slug));
}

export function getRequiredChannelById(ctx: ReadDbCtx, channelId: bigint) {
  const channel = ctx.db.channel.id.find(channelId);
  if (!channel) {
    throw new SenderError('Channel was not found');
  }
  return channel;
}

export function getRequiredChannelBySlug(ctx: ReadDbCtx, slug: string) {
  const channel = getChannelBySlug(ctx, slug);
  if (!channel) {
    throw new SenderError('Channel was not found');
  }
  return channel;
}

export function resolveRequiredChannel(
  ctx: ReadDbCtx,
  params: { channelId?: bigint; channelSlug?: string }
) {
  if (params.channelId !== undefined && params.channelSlug?.trim()) {
    throw new SenderError('Choose either channelId or channelSlug');
  }
  if (params.channelId !== undefined) {
    return getRequiredChannelById(ctx, params.channelId);
  }
  if (params.channelSlug?.trim()) {
    return getRequiredChannelBySlug(ctx, params.channelSlug);
  }
  throw new SenderError('channelId or channelSlug is required');
}

export function getRequiredChannelJoinRequestByRowId(ctx: ReadDbCtx, requestId: bigint) {
  const request = ctx.db.channelJoinRequest.id.find(requestId);
  if (!request) {
    throw new SenderError('Channel join request was not found');
  }
  return request;
}

export function getOwnedInboxAnyStatus(ctx: ReadAuthCtx) {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    throw new SenderError('No inbox is bound to this identity');
  }
  requireInboxMatchesOidcIdentity(ctx, inbox);
  return inbox;
}

export function hasSenderAuth(ctx: MaybeReadAuthCtx): ctx is ReadAuthCtx {
  return Boolean(ctx.senderAuth);
}

export function getReadableInbox(ctx: MaybeReadAuthCtx) {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    return null;
  }

  try {
    requireVerifiedInbox(inbox);
    if (!getActiveInboxAuthLease(ctx, inbox)) {
      return null;
    }
    return inbox;
  } catch {
    return null;
  }
}

export function requireInboxMatchesOidcClaims(
  inbox: ReturnType<typeof getRequiredInboxById>,
  oidcClaims: OidcIdentityClaims
) {
  if (inbox.authIssuer !== oidcClaims.issuer || inbox.authSubject !== oidcClaims.subject) {
    throw new SenderError('Current OIDC session is not authorized for this inbox');
  }
  if (inbox.normalizedEmail !== oidcClaims.normalizedEmail) {
    throw new SenderError('Current OIDC session email does not match this inbox namespace');
  }
}

export function requireInboxMatchesOidcIdentity(
  ctx: ReadAuthCtx,
  inbox: ReturnType<typeof getRequiredInboxById>
) {
  const oidcClaims = requireOidcIdentityClaims(ctx);
  requireInboxMatchesOidcClaims(inbox, oidcClaims);
}

export function requireVerifiedInbox(inbox: ReturnType<typeof getRequiredInboxById>) {
  if (!inbox.authVerified || !inbox.emailAttested) {
    throw new SenderError('Inbox auth verification is required before this action');
  }
}

export function getOwnedInbox(ctx: ReadAuthCtx) {
  const inbox = getOwnedInboxAnyStatus(ctx);
  requireVerifiedInbox(inbox);
  return inbox;
}

export function getOwnedActorWithInbox(
  ctx: ModuleCtx,
  agentDbId: bigint
): { actor: ActorRow; inbox: InboxRow } {
  const actor = getRequiredActorByDbId(ctx, agentDbId);
  const inbox = getOwnedInbox(ctx);
  if (actor.inboxId !== inbox.id) {
    throw new SenderError('Actor is not owned by this inbox identity');
  }
  return { actor, inbox };
}

export function getOwnedActor(ctx: ModuleCtx, agentDbId: bigint) {
  const { actor } = getOwnedActorWithInbox(ctx, agentDbId);
  return actor;
}

export function getOwnedActorForRead(ctx: ReadAuthCtx, agentDbId: bigint) {
  const actor = getRequiredActorByDbId(ctx, agentDbId);
  const inbox = getOwnedInbox(ctx);
  if (actor.inboxId !== inbox.id) {
    throw new SenderError('Actor is not owned by this inbox identity');
  }
  return actor;
}

export function getContactRequestByThreadId(ctx: ReadDbCtx, threadId: bigint) {
  return (
    Array.from(ctx.db.contactRequest.contact_request_thread_id.filter(threadId))
      .sort((left, right) => {
        const timeOrder = compareTimestamp(right.updatedAt, left.updatedAt);
        if (timeOrder !== 0) return timeOrder;
        if (right.id > left.id) return 1;
        if (right.id < left.id) return -1;
        return 0;
      })[0] ?? null
  );
}

export function hasDirectThreadParticipants(
  ctx: ReadDbCtx,
  threadId: bigint,
  leftActorId: bigint,
  rightActorId: bigint
) {
  const participants = getActiveThreadParticipants(ctx, threadId);
  return (
    participants.some(participant => participant.agentDbId === leftActorId) &&
    participants.some(participant => participant.agentDbId === rightActorId)
  );
}

export function hasApprovedDirectThreadForActors(
  ctx: ReadDbCtx,
  leftActor: ReturnType<typeof getRequiredActorByDbId>,
  rightActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const directKey = buildDirectKey(leftActor, rightActor);
  return getDirectThreadsForKey(ctx, directKey).some(thread => {
    if (thread.kind !== 'direct' || thread.dedupeKey !== directKey) {
      return false;
    }
    if (!hasDirectThreadParticipants(ctx, thread.id, leftActor.id, rightActor.id)) {
      return false;
    }
    const request = getContactRequestByThreadId(ctx, thread.id);
    return !request || request.status.tag === 'approved';
  });
}

export function findPendingContactRequestForActors(
  ctx: ReadDbCtx,
  leftActor: ReturnType<typeof getRequiredActorByDbId>,
  rightActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const directKey = buildDirectKey(leftActor, rightActor);
  return getDirectThreadsForKey(ctx, directKey)
    .filter(thread => hasDirectThreadParticipants(ctx, thread.id, leftActor.id, rightActor.id))
    .map(thread => getContactRequestByThreadId(ctx, thread.id))
    .find((request): request is NonNullable<typeof request> => {
      return Boolean(request && request.status.tag === 'pending');
    });
}

export function isSenderOnAllowlistForTargetInbox(
  ctx: ReadDbCtx,
  senderActor: ReturnType<typeof getRequiredActorByDbId>,
  targetActor: ReturnType<typeof getRequiredActorByDbId>
) {
  const targetInbox = getRequiredInboxById(ctx, targetActor.inboxId);
  const senderInbox = getRequiredInboxById(ctx, senderActor.inboxId);
  return getContactAllowlistEntriesByInboxId(ctx, targetInbox.id).some(entry => {
    if (entry.inboxId !== targetInbox.id) {
      return false;
    }

    if (entry.kind.tag === 'agent') {
      return entry.agentPublicIdentity === senderActor.publicIdentity;
    }
    if (entry.kind.tag === 'email') {
      return entry.normalizedEmail === senderInbox.normalizedEmail;
    }
    return false;
  });
}

export function isDirectContactAllowed(
  ctx: ReadDbCtx,
  requesterActor: ReturnType<typeof getRequiredActorByDbId>,
  targetActor: ReturnType<typeof getRequiredActorByDbId>
) {
  return (
    isSenderOnAllowlistForTargetInbox(ctx, requesterActor, targetActor) ||
    hasApprovedDirectThreadForActors(ctx, requesterActor, targetActor)
  );
}

export function requirePendingDirectContactResolvedForThreadMutation(
  ctx: ModuleCtx,
  threadId: bigint
) {
  const request = getContactRequestByThreadId(ctx, threadId);
  if (!request) {
    return;
  }

  if (request.status.tag === 'approved') {
    return;
  }

  const requesterActor = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const targetActor = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  if (isDirectContactAllowed(ctx, requesterActor, targetActor)) {
    return;
  }

  throw new SenderError(
    'Pending direct-contact threads cannot change membership or envelopes until the requester is allowlisted or the request is approved'
  );
}

export function isThreadVisibleInNormalViews(ctx: ReadDbCtx, threadId: bigint) {
  const request = getContactRequestByThreadId(ctx, threadId);
  if (!request || request.status.tag === 'approved') {
    return true;
  }

  const requesterActor = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const targetActor = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  return isDirectContactAllowed(ctx, requesterActor, targetActor);
}

export function buildActiveThreadIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const candidateThreadIds = new Set(
    Array.from(ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId))
      .filter(participant => participant.active)
      .map(participant => participant.threadId)
  );

  return new Set(
    Array.from(candidateThreadIds).filter(threadId => isThreadVisibleInNormalViews(ctx, threadId))
  );
}

export function buildVisibleThreadIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const candidateThreadIds = new Set(
    Array.from(ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId)).map(
      participant => participant.threadId
    )
  );

  return new Set(
    Array.from(candidateThreadIds).filter(threadId => isThreadVisibleInNormalViews(ctx, threadId))
  );
}

export function buildVisibleThreadParticipantIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const visibleParticipantIds = new Set<bigint>();
  const activeThreadIds = buildActiveThreadIdsForInbox(ctx, inboxId);
  const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inboxId);
  const ownActorIds = getOwnActorIdsForInbox(ctx, inboxId);

  for (const threadId of activeThreadIds) {
    for (const participant of ctx.db.threadParticipant.thread_participant_thread_id.filter(threadId)) {
      visibleParticipantIds.add(participant.id);
    }
  }

  for (const participant of ctx.db.threadParticipant.thread_participant_inbox_id.filter(inboxId)) {
    if (visibleThreadIds.has(participant.threadId)) {
      visibleParticipantIds.add(participant.id);
    }
  }

  for (const agentDbId of ownActorIds) {
    for (const envelope of ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(agentDbId)) {
      if (visibleThreadIds.has(envelope.threadId)) {
        const senderParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.senderAgentDbId)
        );
        const recipientParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.recipientAgentDbId)
        );
        if (senderParticipant) visibleParticipantIds.add(senderParticipant.id);
        if (recipientParticipant) visibleParticipantIds.add(recipientParticipant.id);
      }
    }
    for (const envelope of ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)) {
      if (visibleThreadIds.has(envelope.threadId)) {
        const senderParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.senderAgentDbId)
        );
        const recipientParticipant = ctx.db.threadParticipant.uniqueKey.find(
          buildThreadParticipantKey(envelope.threadId, envelope.recipientAgentDbId)
        );
        if (senderParticipant) visibleParticipantIds.add(senderParticipant.id);
        if (recipientParticipant) visibleParticipantIds.add(recipientParticipant.id);
      }
    }
  }

  return visibleParticipantIds;
}

export function buildVisibleAgentIdsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  const ownActorIds = getOwnActorIdsForInbox(ctx, inboxId);
  const visibleActorIds = new Set<bigint>(ownActorIds);

  for (const participantId of buildVisibleThreadParticipantIdsForInbox(ctx, inboxId)) {
    const participant = ctx.db.threadParticipant.id.find(participantId);
    if (participant) {
      visibleActorIds.add(participant.agentDbId);
    }
  }

  return visibleActorIds;
}

export function isActorOwnedByInbox(actor: ActorRow, inboxId: bigint) {
  return actor.inboxId === inboxId;
}

export function getActorLinkedEmailForViewer(ctx: ReadDbCtx, inboxId: bigint, actor: ActorRow) {
  if (!actor.publicLinkedEmailEnabled && !isActorOwnedByInbox(actor, inboxId)) {
    return null;
  }
  return getRequiredInboxById(ctx, actor.inboxId);
}

export function toSanitizedVisibleAgentRow(ctx: ReadDbCtx, inboxId: bigint, actor: ActorRow) {
  if (isActorOwnedByInbox(actor, inboxId)) {
    return actor;
  }

  const linkedInbox = getActorLinkedEmailForViewer(ctx, inboxId, actor);
  return {
    id: actor.id,
    inboxId: 0n,
    normalizedEmail: linkedInbox?.normalizedEmail ?? '',
    slug: actor.slug,
    inboxIdentifier: undefined,
    isDefault: false,
    publicIdentity: actor.publicIdentity,
    displayName: actor.displayName,
    publicLinkedEmailEnabled: actor.publicLinkedEmailEnabled,
    publicDescription: actor.publicDescription,
    allowAllMessageContentTypes: actor.allowAllMessageContentTypes,
    allowAllMessageHeaders: actor.allowAllMessageHeaders,
    supportedMessageContentTypes: actor.supportedMessageContentTypes,
    supportedMessageHeaderNames: actor.supportedMessageHeaderNames,
    currentEncryptionPublicKey: actor.currentEncryptionPublicKey,
    currentEncryptionKeyVersion: actor.currentEncryptionKeyVersion,
    currentEncryptionAlgorithm: actor.currentEncryptionAlgorithm,
    currentSigningPublicKey: actor.currentSigningPublicKey,
    currentSigningKeyVersion: actor.currentSigningKeyVersion,
    currentSigningAlgorithm: actor.currentSigningAlgorithm,
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier,
    masumiRegistrationState: undefined,
    createdAt: actor.createdAt,
    updatedAt: actor.updatedAt,
  };
}

export function toVisibleContactRequestRow(
  ctx: ReadDbCtx,
  inboxId: bigint,
  request: ReturnType<typeof getRequiredContactRequestByRowId>
) {
  const requester = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
  const target = getRequiredActorByDbId(ctx, request.targetAgentDbId);
  const requesterEmail = getActorLinkedEmailForViewer(ctx, inboxId, requester);
  const targetEmail = getActorLinkedEmailForViewer(ctx, inboxId, target);
  return {
    id: request.id,
    threadId: request.threadId,
    requesterAgentDbId: request.requesterAgentDbId,
    requesterPublicIdentity: request.requesterPublicIdentity,
    requesterSlug: request.requesterSlug,
    requesterDisplayName: request.requesterDisplayName,
    requesterNormalizedEmail: requesterEmail?.normalizedEmail ?? '',
    requesterDisplayEmail: requesterEmail?.displayEmail ?? '',
    requesterLinkedEmail: requesterEmail?.displayEmail,
    targetAgentDbId: request.targetAgentDbId,
    targetPublicIdentity: request.targetPublicIdentity,
    targetSlug: request.targetSlug,
    targetDisplayName: request.targetDisplayName ?? target.displayName,
    targetLinkedEmail: targetEmail?.displayEmail,
    direction: target.inboxId === inboxId ? 'incoming' : 'outgoing',
    status: request.status.tag,
    messageCount: ctx.db.thread.id.find(request.threadId)?.lastMessageSeq ?? 0n,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
    resolvedByAgentDbId: request.resolvedByAgentDbId,
  };
}

export function toVisibleThreadInviteRow(ctx: ReadDbCtx, invite: ThreadInviteRow) {
  const thread = ctx.db.thread.id.find(invite.threadId);
  const inviter = getRequiredActorByDbId(ctx, invite.inviterAgentDbId);
  const invitee = getRequiredActorByDbId(ctx, invite.inviteeAgentDbId);
  return {
    id: invite.id,
    threadId: invite.threadId,
    inviterAgentDbId: invite.inviterAgentDbId,
    inviterPublicIdentity: inviter.publicIdentity,
    inviterSlug: inviter.slug,
    inviterDisplayName: inviter.displayName,
    inviteeAgentDbId: invite.inviteeAgentDbId,
    inviteePublicIdentity: invitee.publicIdentity,
    inviteeSlug: invitee.slug,
    inviteeDisplayName: invitee.displayName,
    threadTitle: thread?.title,
    status: invite.status,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    resolvedAt: invite.resolvedAt,
    resolvedByAgentDbId: invite.resolvedByAgentDbId,
  };
}

export function getVisibleContactRequestsForInbox(ctx: ReadDbCtx, inboxId: bigint) {
  return dedupeRowsById(
    Array.from(getOwnActorIdsForInbox(ctx, inboxId)).flatMap(agentDbId => [
      ...Array.from(ctx.db.contactRequest.contact_request_requester_agent_db_id.filter(agentDbId)),
      ...Array.from(ctx.db.contactRequest.contact_request_target_agent_db_id.filter(agentDbId)),
    ])
  );
}

export function getOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return getDevicesByInboxId(ctx, inbox.id);
}

export function getOwnedDevice(ctx: DeviceReadAuthCtx, deviceId: string) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const inbox = getOwnedInbox(ctx);
  const device = getDeviceByInboxDeviceId(ctx, inbox.id, normalizedDeviceId);
  if (!device || device.inboxId !== inbox.id) {
    throw new SenderError('Device was not found for this inbox');
  }
  return device;
}

export function upsertInboxDevice(
  ctx: ModuleCtx,
  inboxId: bigint,
  {
    deviceId,
    label,
      platform,
      deviceEncryptionPublicKey,
      deviceEncryptionKeyVersion,
      deviceEncryptionAlgorithm,
    }: {
      deviceId: string;
      label?: string;
      platform?: string;
      deviceEncryptionPublicKey: string;
      deviceEncryptionKeyVersion: string;
      deviceEncryptionAlgorithm?: string;
    },
  options?: { autoApprove?: boolean }
) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const normalizedLabel = normalizeOptionalDeviceLabel(label);
  const normalizedPlatform = normalizeOptionalPlatform(platform);
  const normalizedDeviceEncryptionPublicKey = normalizePublicKey(
    deviceEncryptionPublicKey,
    'deviceEncryptionPublicKey'
  );
    const normalizedDeviceEncryptionKeyVersion = requireNonEmpty(
      deviceEncryptionKeyVersion,
      'deviceEncryptionKeyVersion'
    );
    const normalizedDeviceEncryptionAlgorithm = normalizeOptionalAlgorithm(
      deviceEncryptionAlgorithm,
      DEFAULT_DEVICE_ENCRYPTION_ALGORITHM,
      'deviceEncryptionAlgorithm'
    );
    const autoApprove = options?.autoApprove === true;

  requireMaxLength(
    normalizedDeviceEncryptionKeyVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'deviceEncryptionKeyVersion'
  );

  const existing = getDeviceByInboxDeviceId(ctx, inboxId, normalizedDeviceId);
  if (!existing) {
    ctx.db.device.insert({
      id: 0n,
      deviceId: normalizedDeviceId,
      inboxId,
      uniqueKey: buildDeviceKey(inboxId, normalizedDeviceId),
      label: normalizedLabel,
	        platform: normalizedPlatform,
	        deviceEncryptionPublicKey: normalizedDeviceEncryptionPublicKey,
        deviceEncryptionKeyVersion: normalizedDeviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm: normalizedDeviceEncryptionAlgorithm,
        status: normalizeDeviceStatus(autoApprove ? 'approved' : 'pending'),
      approvedAt: autoApprove ? ctx.timestamp : undefined,
      revokedAt: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
    return;
  }

	    const keyChanged =
	      existing.deviceEncryptionPublicKey !== normalizedDeviceEncryptionPublicKey ||
	      existing.deviceEncryptionKeyVersion !== normalizedDeviceEncryptionKeyVersion ||
	      existing.deviceEncryptionAlgorithm !== normalizedDeviceEncryptionAlgorithm;
  const shouldResetApproval = Boolean(existing.revokedAt) || keyChanged;
  if (keyChanged) {
    invalidatePendingDeviceShareRequests(ctx, inboxId, normalizedDeviceId);
    invalidatePendingDeviceKeyBundles(ctx, inboxId, normalizedDeviceId);
  }

  ctx.db.device.id.update({
    ...existing,
    label: normalizedLabel,
      platform: normalizedPlatform,
      deviceEncryptionPublicKey: normalizedDeviceEncryptionPublicKey,
      deviceEncryptionKeyVersion: normalizedDeviceEncryptionKeyVersion,
      deviceEncryptionAlgorithm: normalizedDeviceEncryptionAlgorithm,
    status: normalizeDeviceStatus(
      autoApprove
        ? 'approved'
        : shouldResetApproval
          ? 'pending'
          : existing.approvedAt
            ? 'approved'
            : existing.status
    ),
    approvedAt: autoApprove
      ? existing.approvedAt ?? ctx.timestamp
      : shouldResetApproval
        ? undefined
        : existing.approvedAt,
    revokedAt: autoApprove ? undefined : shouldResetApproval ? undefined : existing.revokedAt,
    updatedAt: ctx.timestamp,
    lastSeenAt: ctx.timestamp,
  });
}

export function getRequestsForOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return Array.from(ctx.db.deviceShareRequest.device_share_request_inbox_id.filter(inbox.id));
}

export function getBundlesForOwnedDevices(ctx: DeviceReadAuthCtx) {
  const inbox = getOwnedInbox(ctx);
  return Array.from(ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inbox.id));
}

export function isPendingDeviceShareRequest(
  request: ReturnType<typeof getRequiredDeviceShareRequestByRowId>,
  now: Timestamp
) {
  return !request.approvedAt && !request.consumedAt && !isTimestampExpired(request.expiresAt, now);
}

export function isNeverExpiringDeviceKeyBundle(
  bundle: ReturnType<typeof getRequiredDeviceKeyBundleByRowId>
) {
  return bundle.expiryMode.tag === 'neverExpires';
}

export function isClaimableDeviceKeyBundle(
  bundle: ReturnType<typeof getRequiredDeviceKeyBundleByRowId>,
  now: Timestamp
) {
  return !bundle.consumedAt && (isNeverExpiringDeviceKeyBundle(bundle) || !isTimestampExpired(bundle.expiresAt, now));
}

export function invalidatePendingDeviceShareRequests(
  ctx: ModuleCtx,
  inboxId: bigint,
  deviceId: string,
  options?: { approvedAt?: Timestamp; consumedAt?: Timestamp }
) {
  for (const request of ctx.db.deviceShareRequest.device_share_request_device_id.filter(deviceId)) {
    if (request.inboxId !== inboxId) continue;
    if (request.consumedAt) continue;

    ctx.db.deviceShareRequest.id.update({
      ...request,
      approvedAt: options?.approvedAt ?? request.approvedAt,
      consumedAt: options?.consumedAt ?? ctx.timestamp,
    });
  }
}

export function invalidatePendingDeviceKeyBundles(ctx: ModuleCtx, inboxId: bigint, deviceId: string) {
  for (const bundle of ctx.db.deviceKeyBundle.device_key_bundle_target_device_id.filter(deviceId)) {
    if (bundle.inboxId !== inboxId) continue;
    if (bundle.consumedAt) continue;
    ctx.db.deviceKeyBundle.id.update({
      ...bundle,
      consumedAt: ctx.timestamp,
    });
  }
}

export function scheduleDeviceKeyBundleExpiry(ctx: ModuleCtx, bundle: DeviceKeyBundleRow) {
  if (isNeverExpiringDeviceKeyBundle(bundle)) {
    return;
  }
  for (const expiry of ctx.db.deviceKeyBundleExpiry.device_key_bundle_expiry_bundle_id.filter(
    bundle.id
  )) {
    if (expiry.expiresAt.microsSinceUnixEpoch === bundle.expiresAt.microsSinceUnixEpoch) {
      return;
    }
  }

  ctx.db.deviceKeyBundleExpiry.insert({
    id: 0n,
    scheduledAt: ScheduleAt.time(bundle.expiresAt.microsSinceUnixEpoch),
    bundleId: bundle.id,
    expiresAt: bundle.expiresAt,
    createdAt: ctx.timestamp,
  });
}

export function reconcileDeviceKeyBundleExpiryState(ctx: ModuleCtx, inboxId: bigint, now: Timestamp) {
  for (const bundle of ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inboxId)) {
    if (bundle.consumedAt || isNeverExpiringDeviceKeyBundle(bundle)) {
      continue;
    }

    if (isTimestampExpired(bundle.expiresAt, now)) {
      ctx.db.deviceKeyBundle.id.update({
        ...bundle,
        consumedAt: now,
      });
      continue;
    }

    scheduleDeviceKeyBundleExpiry(ctx, bundle);
  }
}

export function insertDeviceKeyBundle(
  ctx: ModuleCtx,
  attachment: {
    deviceId: string;
      sourceDeviceId?: string;
      sourceEncryptionPublicKey: string;
      sourceEncryptionKeyVersion: string;
      sourceEncryptionAlgorithm?: string;
      bundleCiphertext: string;
    bundleIv: string;
    bundleAlgorithm: string;
    sharedAgentCount: bigint;
    sharedKeyVersionCount: bigint;
    expiresAt: Timestamp;
    expiryMode: DeviceKeyBundleExpiryModeValue;
  }
) {
  const normalizedDeviceId = normalizeDeviceId(attachment.deviceId);
  const targetDevice = getOwnedDevice(ctx, normalizedDeviceId);
  if (targetDevice.revokedAt || targetDevice.status === 'revoked') {
    throw new SenderError(`Device ${normalizedDeviceId} is revoked`);
  }

  const normalizedSourceDeviceId = attachment.sourceDeviceId?.trim() || undefined;
  const normalizedSourceEncryptionPublicKey = normalizePublicKey(
    attachment.sourceEncryptionPublicKey,
    'sourceEncryptionPublicKey'
  );
    const normalizedSourceEncryptionKeyVersion = requireNonEmpty(
      attachment.sourceEncryptionKeyVersion,
      'sourceEncryptionKeyVersion'
    );
    const normalizedSourceEncryptionAlgorithm = normalizeOptionalAlgorithm(
      attachment.sourceEncryptionAlgorithm,
      DEFAULT_DEVICE_ENCRYPTION_ALGORITHM,
      'sourceEncryptionAlgorithm'
    );
  const normalizedBundleCiphertext = requireHexMaxLength(
    attachment.bundleCiphertext,
    MAX_DEVICE_BUNDLE_CIPHERTEXT_HEX_CHARS,
    'bundleCiphertext'
  );
  const normalizedBundleIv = requireHexMaxLength(
    attachment.bundleIv,
    MAX_MESSAGE_IV_HEX_CHARS,
    'bundleIv'
  );
  const normalizedBundleAlgorithm = requireNonEmpty(
    attachment.bundleAlgorithm,
    'bundleAlgorithm'
  );

  requireMaxLength(
    normalizedSourceEncryptionKeyVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'sourceEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedBundleAlgorithm,
    MAX_DEVICE_BUNDLE_ALGORITHM_CHARS,
    'bundleAlgorithm'
  );
  requireClaimableDeviceKeyBundleExpiry(ctx.timestamp, attachment.expiresAt);

  invalidatePendingDeviceKeyBundles(ctx, targetDevice.inboxId, normalizedDeviceId);

  const insertedBundle = ctx.db.deviceKeyBundle.insert({
    id: 0n,
    targetDeviceId: normalizedDeviceId,
    inboxId: targetDevice.inboxId,
	      sourceDeviceId: normalizedSourceDeviceId,
	      sourceEncryptionPublicKey: normalizedSourceEncryptionPublicKey,
      sourceEncryptionKeyVersion: normalizedSourceEncryptionKeyVersion,
      sourceEncryptionAlgorithm: normalizedSourceEncryptionAlgorithm,
      bundleCiphertext: normalizedBundleCiphertext,
    bundleIv: normalizedBundleIv,
    bundleAlgorithm: normalizedBundleAlgorithm,
    sharedAgentCount: attachment.sharedAgentCount,
    sharedKeyVersionCount: attachment.sharedKeyVersionCount,
    createdAt: ctx.timestamp,
    expiresAt: attachment.expiresAt,
    consumedAt: undefined,
    expiryMode: attachment.expiryMode,
  });
  scheduleDeviceKeyBundleExpiry(ctx, insertedBundle);
}

export function getThreadParticipants(ctx: ReadDbCtx, threadId: bigint) {
  return Array.from(ctx.db.threadParticipant.thread_participant_thread_id.filter(threadId));
}

export function getActiveThreadParticipants(ctx: ReadDbCtx, threadId: bigint) {
  return getThreadParticipants(ctx, threadId).filter(participant => participant.active);
}

export function getThreadInvites(ctx: ReadDbCtx, threadId: bigint) {
  return Array.from(ctx.db.threadInvite.thread_invite_thread_id.filter(threadId));
}

export function getPendingThreadInvites(ctx: ReadDbCtx, threadId: bigint) {
  return getThreadInvites(ctx, threadId).filter(invite => invite.status === 'pending');
}

export function requireThreadFanoutCapacity(ctx: ReadDbCtx, threadId: bigint, additionalCount = 1) {
  const activeCount = getActiveThreadParticipants(ctx, threadId).length;
  const pendingCount = getPendingThreadInvites(ctx, threadId).length;
  if (activeCount + pendingCount + additionalCount > MAX_THREAD_FANOUT) {
    throw new SenderError(
      `Threads may include at most ${MAX_THREAD_FANOUT.toString()} active or pending participants`
    );
  }
}

export function ensureThreadInvite(
  ctx: ModuleCtx,
  threadId: bigint,
  inviterAgent: ReturnType<typeof getRequiredActorByDbId>,
  inviteeAgent: ReturnType<typeof getRequiredActorByDbId>
): boolean {
  const existing = ctx.db.threadInvite.uniqueKey.find(
    buildThreadInviteKey(threadId, inviteeAgent.id)
  );

  if (!existing) {
    requireThreadFanoutCapacity(ctx, threadId);
    ctx.db.threadInvite.insert({
      id: 0n,
      threadId,
      inviterAgentDbId: inviterAgent.id,
      inviteeAgentDbId: inviteeAgent.id,
      inviteeInboxId: inviteeAgent.inboxId,
      uniqueKey: buildThreadInviteKey(threadId, inviteeAgent.id),
      status: normalizeThreadInviteStatus('pending'),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
    return true;
  }

  if (existing.status === 'pending') {
    return false;
  }

  requireThreadFanoutCapacity(ctx, threadId);
  ctx.db.threadInvite.id.update({
    ...existing,
    inviterAgentDbId: inviterAgent.id,
    inviteeInboxId: inviteeAgent.inboxId,
    status: normalizeThreadInviteStatus('pending'),
    updatedAt: ctx.timestamp,
    resolvedAt: undefined,
    resolvedByAgentDbId: undefined,
  });
  return true;
}

export function resolveThreadInvite(
  ctx: ModuleCtx,
  invite: ThreadInviteRow,
  status: (typeof THREAD_INVITE_STATUSES)[number],
  resolverAgentDbId: bigint
) {
  ctx.db.threadInvite.id.update({
    ...invite,
    status: normalizeThreadInviteStatus(status),
    updatedAt: ctx.timestamp,
    resolvedAt: ctx.timestamp,
    resolvedByAgentDbId: resolverAgentDbId,
  });
}

export function deleteThreadAndDependents(
  ctx: ModuleCtx,
  threadId: bigint,
  options?: { preserveContactRequests?: boolean }
) {
  const directIndex = ctx.db.directThreadIndex.threadId.find(threadId);
  if (directIndex) {
    ctx.db.directThreadIndex.id.delete(directIndex.id);
  }
  for (const message of Array.from(ctx.db.message.message_thread_id.filter(threadId))) {
    ctx.db.message.id.delete(message.id);
  }
  for (const envelope of Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_thread_id.filter(threadId)
  )) {
    ctx.db.threadSecretEnvelope.id.delete(envelope.id);
  }
  for (const readState of Array.from(
    ctx.db.threadReadState.thread_read_state_thread_id.filter(threadId)
  )) {
    ctx.db.threadReadState.id.delete(readState.id);
  }
  for (const invite of getThreadInvites(ctx, threadId)) {
    ctx.db.threadInvite.id.delete(invite.id);
  }
  for (const participant of getThreadParticipants(ctx, threadId)) {
    ctx.db.threadParticipant.id.delete(participant.id);
  }
  if (!options?.preserveContactRequests) {
    for (const request of Array.from(
      ctx.db.contactRequest.contact_request_thread_id.filter(threadId)
    )) {
      ctx.db.contactRequest.id.delete(request.id);
    }
  }
  ctx.db.thread.id.delete(threadId);
}

export function requireCurrentEnvelopeVersions(params: {
  senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  recipientAgent: ReturnType<typeof getRequiredActorByDbId>;
  senderEncryptionKeyVersion: string;
  recipientEncryptionKeyVersion: string;
  signingKeyVersion: string;
}) {
  const normalizedSenderEncryptionVersion = requireNonEmpty(
    params.senderEncryptionKeyVersion,
    'senderEncryptionKeyVersion'
  );
  const normalizedRecipientEncryptionVersion = requireNonEmpty(
    params.recipientEncryptionKeyVersion,
    'recipientEncryptionKeyVersion'
  );
  const normalizedSigningVersion = requireNonEmpty(
    params.signingKeyVersion,
    'signingKeyVersion'
  );
  requireMaxLength(
    normalizedSenderEncryptionVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'senderEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedRecipientEncryptionVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'recipientEncryptionKeyVersion'
  );
  requireMaxLength(
    normalizedSigningVersion,
    MAX_MESSAGE_VERSION_CHARS,
    'signingKeyVersion'
  );

  if (normalizedSenderEncryptionVersion !== params.senderAgent.currentEncryptionKeyVersion) {
    throw new SenderError(
      'senderEncryptionKeyVersion must match the sender current encryption key version'
    );
  }
  if (normalizedRecipientEncryptionVersion !== params.recipientAgent.currentEncryptionKeyVersion) {
    throw new SenderError(
      'recipientEncryptionKeyVersion must match the recipient current encryption key version'
    );
  }
  if (normalizedSigningVersion !== params.senderAgent.currentSigningKeyVersion) {
    throw new SenderError('signingKeyVersion must match the sender current signing key version');
  }
}

export function buildDirectKey(
  left: { publicIdentity: string },
  right: { publicIdentity: string }
): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}

export function getDirectThreadsForKey(ctx: ReadDbCtx, directKey: string) {
  const byId = new Map<string, ThreadRow>();
  for (const indexed of ctx.db.directThreadIndex.direct_thread_index_direct_key.filter(directKey)) {
    const thread = ctx.db.thread.id.find(indexed.threadId);
    if (thread) {
      byId.set(thread.id.toString(), thread);
    }
  }

  for (const thread of ctx.db.thread.thread_dedupe_key.filter(directKey)) {
    if (thread.kind === 'direct' && thread.dedupeKey === directKey) {
      byId.set(thread.id.toString(), thread);
    }
  }

  return Array.from(byId.values());
}

export function buildGroupKey(
  actor: { publicIdentity: string },
  sequence: bigint
): string {
  return `group:${actor.publicIdentity}:${sequence.toString()}`;
}

export function createDirectThreadRecord(
  ctx: ModuleCtx,
  actor: ReturnType<typeof getRequiredActorByDbId>,
  otherActor: ReturnType<typeof getRequiredActorByDbId>,
  options?: { membershipLocked?: boolean; title?: string; threadId?: bigint }
) {
  const directKey = buildDirectKey(actor, otherActor);
  const directThreadId = options?.threadId ?? 0n;

  if (options?.threadId !== undefined) {
    if (directThreadId === 0n) {
      throw new SenderError('threadId must be non-zero');
    }
    if (!isClientGeneratedThreadId(directThreadId)) {
      throw new SenderError('threadId must be a client-generated thread id');
    }
    if (ctx.db.thread.id.find(directThreadId)) {
      throw new SenderError('Thread id collision detected. Generate a new thread id and try again.');
    }
  }

  const thread = ctx.db.thread.insert({
    id: directThreadId,
    dedupeKey: directKey,
    kind: 'direct',
    membershipLocked: options?.membershipLocked ?? true,
    title: normalizeOptionalThreadTitle(options?.title),
    creatorAgentDbId: actor.id,
    membershipVersion: 1n,
    nextThreadSeq: 1n,
    lastMessageSeq: 0n,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    lastMessageAt: ctx.timestamp,
  });

  ctx.db.directThreadIndex.insert({
    id: 0n,
    directKey,
    threadId: thread.id,
    createdAt: ctx.timestamp,
  });

  ensureThreadParticipant(ctx, thread.id, actor, { isAdmin: true });
  ensureThreadParticipant(ctx, thread.id, otherActor);
  return thread;
}

export function ensureThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  actor: { id: bigint; inboxId: bigint },
  options?: { isAdmin?: boolean }
): boolean {
  const existingParticipant = getThreadParticipants(ctx, threadId).find(participant => {
    return participant.agentDbId === actor.id;
  });

  if (!existingParticipant) {
    ctx.db.threadParticipant.insert({
      id: 0n,
      threadId,
      agentDbId: actor.id,
      inboxId: actor.inboxId,
      uniqueKey: buildThreadParticipantKey(threadId, actor.id),
      joinedAt: ctx.timestamp,
      lastSentSeq: 0n,
      lastSentMembershipVersion: undefined,
      lastSentSecretVersion: undefined,
      isAdmin: options?.isAdmin ?? false,
      active: true,
      });
      return true;
    }

    const wasInactive = !existingParticipant.active;
    const needsInboxIdBackfill = existingParticipant.inboxId !== actor.inboxId;
    if (
      wasInactive ||
      needsInboxIdBackfill ||
      ((options?.isAdmin ?? false) && !existingParticipant.isAdmin)
    ) {
      ctx.db.threadParticipant.id.update({
        ...existingParticipant,
        inboxId: actor.inboxId,
        active: true,
        isAdmin: existingParticipant.isAdmin || (options?.isAdmin ?? false),
      });
    }
    return wasInactive;
}

export function requireActiveThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = getActiveThreadParticipants(ctx, threadId).find(
    row => row.agentDbId === agentDbId
  );
  if (!participant) {
    throw new SenderError('Actor is not a participant in this thread');
  }
  return participant;
}

export function requireVisibleThreadParticipant(
  ctx: ReadDbCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = getThreadParticipants(ctx, threadId).find(
    row => row.agentDbId === agentDbId
  );
  if (!participant) {
    throw new SenderError('Actor is not a participant in this thread');
  }
  if (!isThreadVisibleInNormalViews(ctx, threadId)) {
    throw new SenderError('Thread is not visible to this actor');
  }
  return participant;
}

export function requireAdminThreadParticipant(
  ctx: ModuleCtx,
  threadId: bigint,
  agentDbId: bigint
) {
  const participant = requireActiveThreadParticipant(ctx, threadId, agentDbId);
  if (!participant.isAdmin) {
    throw new SenderError('Actor is not an admin in this thread');
  }
  return participant;
}

export function promoteReplacementAdmin(ctx: ModuleCtx, threadId: bigint) {
  const activeParticipants = getActiveThreadParticipants(ctx, threadId);
  if (activeParticipants.length === 0) return;
  if (activeParticipants.some(participant => participant.isAdmin)) return;

  const [nextAdmin] = [...activeParticipants].sort((left, right) => Number(left.id - right.id));
  if (!nextAdmin) return;

  ctx.db.threadParticipant.id.update({
    ...nextAdmin,
    isAdmin: true,
  });
}

export function getSenderLastSentState(
  senderParticipant: ThreadParticipantRow
): { membershipVersion: bigint; secretVersion: string } | null {
  if (
    senderParticipant.lastSentSeq === 0n ||
    senderParticipant.lastSentMembershipVersion === undefined ||
    senderParticipant.lastSentSecretVersion === undefined
  ) {
    return null;
  }
  return {
    membershipVersion: senderParticipant.lastSentMembershipVersion,
    secretVersion: senderParticipant.lastSentSecretVersion,
  };
}

export function getSecretEnvelopesForVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return getSecretEnvelopesForSenderSecretVersion(
    ctx,
    threadId,
    senderAgentDbId,
    secretVersion
  ).filter(envelope => envelope.membershipVersion === membershipVersion);
}

export function getSecretEnvelopesForSenderSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(senderAgentDbId)
  ).filter(envelope => {
    return (
      envelope.threadId === threadId &&
      envelope.senderAgentDbId === senderAgentDbId &&
      envelope.secretVersion === secretVersion
    );
  });
}

export function senderHasMessageWithSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.message.message_sender_agent_db_id.filter(senderAgentDbId)
  ).some(message => {
    return (
      message.threadId === threadId &&
      message.senderAgentDbId === senderAgentDbId &&
      message.secretVersion === secretVersion
    );
  });
}

export function senderHasMessageForMembershipSecretVersion(
  ctx: ModuleCtx,
  threadId: bigint,
  membershipVersion: bigint,
  senderAgentDbId: bigint,
  secretVersion: string
) {
  return Array.from(
    ctx.db.message.message_sender_agent_db_id.filter(senderAgentDbId)
  ).some(message => {
    return (
      message.threadId === threadId &&
      message.membershipVersion === membershipVersion &&
      message.senderAgentDbId === senderAgentDbId &&
      message.secretVersion === secretVersion
    );
  });
}

export function canAgentReadMessage(ctx: ReadDbCtx, agentDbId: bigint, message: MessageRow) {
  if (message.senderAgentDbId === agentDbId) {
    return true;
  }

  const messageSenderSecretKey = buildSenderSecretVisibilityKey(
    message.membershipVersion,
    message.senderAgentDbId,
    message.secretVersion
  );
  return Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)
  ).some(envelope => {
    return (
      envelope.threadId === message.threadId &&
      buildSenderSecretVisibilityKey(
        envelope.membershipVersion,
        envelope.senderAgentDbId,
        envelope.secretVersion
      ) === messageSenderSecretKey
    );
  });
}

export function getThreadReadStateForActor(ctx: ReadDbCtx, threadId: bigint, agentDbId: bigint) {
  return ctx.db.threadReadState.uniqueKey.find(buildThreadReadStateKey(threadId, agentDbId));
}

export function requireExactEnvelopeCoverageForVersion(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
}) {
  const envelopes = getSecretEnvelopesForVersion(
      params.ctx,
      params.threadId,
      params.membershipVersion,
      params.senderAgent.id,
    params.secretVersion
  );
  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));

  if (envelopes.length !== expectedRecipientIds.size) {
    throw new SenderError('secretVersion does not cover the current active participant set');
  }

  const seenRecipients = new Set<bigint>();
  for (const envelope of envelopes) {
    if (!expectedRecipientIds.has(envelope.recipientAgentDbId)) {
      throw new SenderError('secretVersion includes envelopes for inactive participants');
    }
    if (seenRecipients.has(envelope.recipientAgentDbId)) {
      throw new SenderError('secretVersion includes duplicate recipient envelopes');
    }
    seenRecipients.add(envelope.recipientAgentDbId);

    const recipientActor = getRequiredActorByDbId(params.ctx, envelope.recipientAgentDbId);
    if (
      envelope.senderEncryptionKeyVersion !== params.senderAgent.currentEncryptionKeyVersion ||
      envelope.signingKeyVersion !== params.senderAgent.currentSigningKeyVersion ||
      envelope.recipientEncryptionKeyVersion !== recipientActor.currentEncryptionKeyVersion
    ) {
      throw new SenderError(
        'Sender or recipient key rotated since this secretVersion was published. Rotate the sender secret by attaching fresh envelopes to the next message.'
      );
    }
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });
  }
}

export function validateAttachedSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));

  if (params.attachedSecretEnvelopes.length !== expectedRecipientIds.size) {
    throw new SenderError('Rotation envelopes must cover every active participant exactly once');
  }

  if (
    getSecretEnvelopesForVersion(
        params.ctx,
        params.threadId,
        params.membershipVersion,
        params.senderAgent.id,
      params.secretVersion
    ).length > 0
  ) {
    throw new SenderError('secretVersion is already published for this sender');
  }

  const seenRecipients = new Set<bigint>();
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientPublicIdentity = requireNonEmpty(
      envelope.recipientPublicIdentity,
      'recipientPublicIdentity'
    );
    const recipientActor = getRequiredActorByPublicIdentity(params.ctx, recipientPublicIdentity);

    if (!expectedRecipientIds.has(recipientActor.id)) {
      throw new SenderError('Rotation envelope recipient is not an active participant');
    }
    if (seenRecipients.has(recipientActor.id)) {
      throw new SenderError('Duplicate secret envelope recipient');
    }
    seenRecipients.add(recipientActor.id);

    requireNonEmpty(envelope.recipientEncryptionKeyVersion, 'recipientEncryptionKeyVersion');
    requireNonEmpty(envelope.senderEncryptionKeyVersion, 'senderEncryptionKeyVersion');
    requireNonEmpty(envelope.signingKeyVersion, 'signingKeyVersion');
    requireHexMaxLength(
      envelope.wrappedSecretCiphertext.trim(),
      MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
      'wrappedSecretCiphertext'
    );
    requireHexMaxLength(
      envelope.wrappedSecretIv.trim(),
      MAX_WRAPPED_SECRET_IV_HEX_CHARS,
      'wrappedSecretIv'
    );
    requireNonEmpty(envelope.wrapAlgorithm, 'wrapAlgorithm');
    requireHexMaxLength(
      envelope.signature.trim(),
      MAX_MESSAGE_SIGNATURE_HEX_CHARS,
      'signature'
    );
    requireMaxLength(
      envelope.recipientEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'recipientEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.senderEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'senderEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.signingKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'signingKeyVersion'
    );
    requireMaxLength(
      envelope.wrapAlgorithm.trim(),
      MAX_MESSAGE_ALGORITHM_CHARS,
      'wrapAlgorithm'
    );
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });
  }
}

export function validateBackfillSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  activeParticipants: ReturnType<typeof getActiveThreadParticipants>;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  if (params.attachedSecretEnvelopes.length === 0) {
    throw new SenderError('attachedSecretEnvelopes must include at least one envelope');
  }

  const expectedRecipientIds = new Set(params.activeParticipants.map(row => row.agentDbId));
  const seenRecipients = new Set<bigint>();
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientPublicIdentity = requireNonEmpty(
      envelope.recipientPublicIdentity,
      'recipientPublicIdentity'
    );
    const recipientActor = getRequiredActorByPublicIdentity(params.ctx, recipientPublicIdentity);

    if (!expectedRecipientIds.has(recipientActor.id)) {
      throw new SenderError('Backfill envelope recipient is not an active participant');
    }
    if (seenRecipients.has(recipientActor.id)) {
      throw new SenderError('Duplicate secret envelope recipient');
    }
    seenRecipients.add(recipientActor.id);

    requireNonEmpty(envelope.recipientEncryptionKeyVersion, 'recipientEncryptionKeyVersion');
    requireNonEmpty(envelope.senderEncryptionKeyVersion, 'senderEncryptionKeyVersion');
    requireNonEmpty(envelope.signingKeyVersion, 'signingKeyVersion');
    requireHexMaxLength(
      envelope.wrappedSecretCiphertext.trim(),
      MAX_WRAPPED_SECRET_CIPHERTEXT_HEX_CHARS,
      'wrappedSecretCiphertext'
    );
    requireHexMaxLength(
      envelope.wrappedSecretIv.trim(),
      MAX_WRAPPED_SECRET_IV_HEX_CHARS,
      'wrappedSecretIv'
    );
    requireNonEmpty(envelope.wrapAlgorithm, 'wrapAlgorithm');
    requireHexMaxLength(
      envelope.signature.trim(),
      MAX_MESSAGE_SIGNATURE_HEX_CHARS,
      'signature'
    );
    requireMaxLength(
      envelope.recipientEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'recipientEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.senderEncryptionKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'senderEncryptionKeyVersion'
    );
    requireMaxLength(
      envelope.signingKeyVersion.trim(),
      MAX_MESSAGE_VERSION_CHARS,
      'signingKeyVersion'
    );
    requireMaxLength(
      envelope.wrapAlgorithm.trim(),
      MAX_MESSAGE_ALGORITHM_CHARS,
      'wrapAlgorithm'
    );
    requireCurrentEnvelopeVersions({
      senderAgent: params.senderAgent,
      recipientAgent: recipientActor,
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
      signingKeyVersion: envelope.signingKeyVersion,
    });

    const uniqueKey = buildThreadSecretEnvelopeKey(
      params.threadId,
      params.membershipVersion,
      params.secretVersion,
      params.senderAgent.id,
      recipientActor.id
    );
    if (params.ctx.db.threadSecretEnvelope.uniqueKey.find(uniqueKey)) {
      throw new SenderError('Secret envelope is already published for this recipient');
    }
  }
}

export function insertAttachedSecretEnvelopes(params: {
    ctx: ModuleCtx;
    threadId: bigint;
    membershipVersion: bigint;
    senderAgent: ReturnType<typeof getRequiredActorByDbId>;
  secretVersion: string;
  attachedSecretEnvelopes: Array<{
    recipientPublicIdentity: string;
    recipientEncryptionKeyVersion: string;
    senderEncryptionKeyVersion: string;
    signingKeyVersion: string;
    wrappedSecretCiphertext: string;
    wrappedSecretIv: string;
    wrapAlgorithm: string;
    signature: string;
  }>;
}) {
  for (const envelope of params.attachedSecretEnvelopes) {
    const recipientActor = getRequiredActorByPublicIdentity(
      params.ctx,
      requireNonEmpty(envelope.recipientPublicIdentity, 'recipientPublicIdentity')
    );
    params.ctx.db.threadSecretEnvelope.insert({
        id: 0n,
        threadId: params.threadId,
        membershipVersion: params.membershipVersion,
        secretVersion: params.secretVersion,
      senderAgentDbId: params.senderAgent.id,
      recipientAgentDbId: recipientActor.id,
      uniqueKey: buildThreadSecretEnvelopeKey(
        params.threadId,
        params.membershipVersion,
        params.secretVersion,
        params.senderAgent.id,
        recipientActor.id
      ),
      senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion.trim(),
      recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion.trim(),
      signingKeyVersion: envelope.signingKeyVersion.trim(),
      wrappedSecretCiphertext: envelope.wrappedSecretCiphertext.trim(),
      wrappedSecretIv: envelope.wrappedSecretIv.trim(),
      wrapAlgorithm: envelope.wrapAlgorithm.trim(),
      signature: envelope.signature.trim(),
      createdAt: params.ctx.timestamp,
    });
  }
}

export function channelPermissionRank(permission: string): number {
  if (permission === 'admin') return 3;
  if (permission === 'read_write') return 2;
  if (permission === 'read') return 1;
  return 0;
}

export function getActiveChannelMember(ctx: ReadDbCtx, channelId: bigint, agentDbId: bigint) {
  const member = ctx.db.channelMember.uniqueKey.find(buildChannelMemberKey(channelId, agentDbId));
  return member?.active ? member : null;
}

export function requireActiveChannelMember(ctx: ReadDbCtx, channelId: bigint, agentDbId: bigint) {
  const member = getActiveChannelMember(ctx, channelId, agentDbId);
  if (!member) {
    throw new SenderError('Actor is not an active channel member');
  }
  return member;
}

export function requireAdminChannelMember(ctx: ReadDbCtx, channelId: bigint, agentDbId: bigint) {
  const member = requireActiveChannelMember(ctx, channelId, agentDbId);
  if (member.permission !== 'admin') {
    throw new SenderError('Actor is not a channel admin');
  }
  return member;
}

export function requireChannelSendPermission(ctx: ReadDbCtx, channelId: bigint, agentDbId: bigint) {
  const member = requireActiveChannelMember(ctx, channelId, agentDbId);
  if (member.permission !== 'read_write' && member.permission !== 'admin') {
    throw new SenderError('Channel permission does not allow sending');
  }
  return member;
}

export function isChannelMemberReadable(member: { active: boolean; permission: string }): boolean {
  if (!member.active) return false;
  return (
    member.permission === 'read' ||
    member.permission === 'read_write' ||
    member.permission === 'admin'
  );
}

export function requireChannelReadPermission(
  ctx: ReadDbCtx,
  channelId: bigint,
  agentDbId: bigint
) {
  const member = requireActiveChannelMember(ctx, channelId, agentDbId);
  if (!isChannelMemberReadable(member)) {
    throw new SenderError('Channel permission does not allow reading');
  }
  return member;
}

export function requireChannelReadableByActor(
  ctx: ReadDbCtx,
  channel: ChannelRow,
  actor: ActorRow
) {
  if (channel.accessMode === 'public') {
    return;
  }
  requireChannelReadPermission(ctx, channel.id, actor.id);
}

export function ensureChannelMember(
  ctx: ModuleCtx,
  channel: ChannelRow,
  actor: ActorRow,
  permission: (typeof CHANNEL_PERMISSIONS)[number]
) {
  const existing = ctx.db.channelMember.uniqueKey.find(
    buildChannelMemberKey(channel.id, actor.id)
  );
  if (!existing) {
    return ctx.db.channelMember.insert({
      id: 0n,
      channelId: channel.id,
      agentDbId: actor.id,
      inboxId: actor.inboxId,
      uniqueKey: buildChannelMemberKey(channel.id, actor.id),
      permission,
      active: true,
      lastSentSeq: 0n,
      joinedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }

  const shouldUpdate =
    !existing.active ||
    existing.inboxId !== actor.inboxId ||
    channelPermissionRank(permission) > channelPermissionRank(existing.permission);
  if (!shouldUpdate) {
    return existing;
  }

  return ctx.db.channelMember.id.update({
    ...existing,
    inboxId: actor.inboxId,
    permission:
      channelPermissionRank(permission) > channelPermissionRank(existing.permission)
        ? permission
        : existing.permission,
    active: true,
    updatedAt: ctx.timestamp,
  });
}

export function requireAnotherActiveChannelAdmin(
  ctx: ReadDbCtx,
  channelId: bigint,
  excludedAgentDbId: bigint
) {
  for (const member of ctx.db.channelMember.channel_member_channel_id_permission_active.filter([
    channelId,
    'admin',
    true,
  ])) {
    if (member.agentDbId !== excludedAgentDbId) {
      return;
    }
  }
  throw new SenderError('Channel must keep at least one active admin');
}

export function deletePublicChannelRow(ctx: ModuleCtx, channelId: bigint) {
  const existingChannel = ctx.db.publicChannel.channelId.find(channelId);
  if (existingChannel) {
    ctx.db.publicChannel.id.delete(existingChannel.id);
  }
}

export function deletePublicChannelMirrorRows(ctx: ModuleCtx, channelId: bigint) {
  deletePublicChannelRow(ctx, channelId);

  for (const message of Array.from(
    ctx.db.publicRecentChannelMessage.public_recent_channel_message_channel_id.filter(channelId)
  )) {
    ctx.db.publicRecentChannelMessage.id.delete(message.id);
  }
}

export function deleteChannelAndDependents(ctx: ModuleCtx, channelId: bigint) {
  deletePublicChannelMirrorRows(ctx, channelId);

  for (const message of Array.from(
    ctx.db.channelMessage.channel_message_channel_id.filter(channelId)
  )) {
    ctx.db.channelMessage.id.delete(message.id);
  }
  for (const request of Array.from(
    ctx.db.channelJoinRequest.channel_join_request_channel_id.filter(channelId)
  )) {
    ctx.db.channelJoinRequest.id.delete(request.id);
  }
  for (const member of Array.from(ctx.db.channelMember.iter()).filter(
    row => row.channelId === channelId
  )) {
    ctx.db.channelMember.id.delete(member.id);
  }

  ctx.db.channel.id.delete(channelId);
}

export function upsertPublicChannelRow(ctx: ModuleCtx, channel: ChannelRow) {
  if (channel.accessMode !== 'public') {
    deletePublicChannelMirrorRows(ctx, channel.id);
    return;
  }
  if (!channel.discoverable) {
    deletePublicChannelMirrorRows(ctx, channel.id);
    return;
  }

  const existing = ctx.db.publicChannel.channelId.find(channel.id);
  const row = {
    channelId: channel.id,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    accessMode: channel.accessMode,
    discoverable: channel.discoverable,
    lastMessageSeq: channel.lastMessageSeq,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    lastMessageAt: channel.lastMessageAt,
  };

  if (existing) {
    ctx.db.publicChannel.id.update({
      ...existing,
      ...row,
    });
    return;
  }

  ctx.db.publicChannel.insert({
    id: 0n,
    ...row,
  });
}

export function getActorSigningPublicKeyForVersion(
  ctx: ReadDbCtx,
  agentDbId: bigint,
  signingKeyVersion: string
): string {
  const actor = getRequiredActorByDbId(ctx, agentDbId);
  if (actor.currentSigningKeyVersion === signingKeyVersion) {
    return actor.currentSigningPublicKey;
  }

  const bundle = Array.from(
    ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(agentDbId)
  ).find(row => row.signingKeyVersion === signingKeyVersion);
  if (!bundle) {
    throw new SenderError('Sender signing key version was not found');
  }
  return bundle.signingPublicKey;
}

export function getActorEncryptionPublicKeyForVersion(
  ctx: ReadDbCtx,
  agentDbId: bigint,
  encryptionKeyVersion: string
): string {
  const actor = getRequiredActorByDbId(ctx, agentDbId);
  if (actor.currentEncryptionKeyVersion === encryptionKeyVersion) {
    return actor.currentEncryptionPublicKey;
  }

  const bundle = Array.from(
    ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(agentDbId)
  ).find(row => row.encryptionKeyVersion === encryptionKeyVersion);
  if (!bundle) {
    throw new SenderError('Sender encryption key version was not found');
  }
  return bundle.encryptionPublicKey;
}

export function toChannelMessageRow(
  ctx: ReadDbCtx,
  message: ChannelMessageRecordRow
) {
  return {
    id: message.id,
    channelId: message.channelId,
    channelSeq: message.channelSeq,
    senderAgentDbId: message.senderAgentDbId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningPublicKey: getActorSigningPublicKeyForVersion(
      ctx,
      message.senderAgentDbId,
      message.senderSigningKeyVersion
    ),
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    signature: message.signature,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  };
}

export function toSelectedPublicRecentChannelMessageRow(
  ctx: ReadDbCtx,
  row: PublicRecentChannelMessageRecordRow
) {
  return {
    id: row.id,
    channelId: row.channelId,
    channelSeq: row.channelSeq,
    senderAgentDbId: row.senderAgentDbId,
    senderPublicIdentity: row.senderPublicIdentity,
    senderSeq: row.senderSeq,
    senderSigningPublicKey: getActorSigningPublicKeyForVersion(
      ctx,
      row.senderAgentDbId,
      row.senderSigningKeyVersion
    ),
    senderSigningKeyVersion: row.senderSigningKeyVersion,
    plaintext: row.plaintext,
    signature: row.signature,
    replyToMessageId: row.replyToMessageId,
    createdAt: row.createdAt,
  };
}

export function insertPublicRecentChannelMessage(ctx: ModuleCtx, message: ChannelMessageRecordRow) {
  const channel = getRequiredChannelById(ctx, message.channelId);
  if (channel.accessMode !== 'public' || !channel.discoverable) {
    return;
  }

  ctx.db.publicRecentChannelMessage.insert({
    id: 0n,
    channelId: message.channelId,
    channelSeq: message.channelSeq,
    channelSeqKey: message.channelSeqKey,
    senderAgentDbId: message.senderAgentDbId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    signature: message.signature,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  });

  const recentRows = Array.from(
    ctx.db.publicRecentChannelMessage.public_recent_channel_message_channel_id.filter(
      message.channelId
    )
  ).sort((left, right) => {
    if (left.channelSeq > right.channelSeq) return -1;
    if (left.channelSeq < right.channelSeq) return 1;
    return Number(right.id - left.id);
  });
  for (const oldRow of recentRows.slice(MAX_CHANNEL_RECENT_PUBLIC_MESSAGES)) {
    ctx.db.publicRecentChannelMessage.id.delete(oldRow.id);
  }
}
