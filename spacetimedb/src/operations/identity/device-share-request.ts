import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import { DEVICE_SHARE_REQUEST_EXPIRY_MS, DEVICE_SHARE_REQUEST_MAX_AGE_MS, DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS } from '../../../../shared/device-share-constants';

import * as model from '../../model';

const {
  DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS,
  DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW,
  DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES,
  VisibleDeviceShareRequestRow,
  ResolvedDeviceShareRequestRow,
  isTimestampExpired,
  durationMillisecondsToMicros,
  timestampPlusMilliseconds,
  enforceRateLimit,
  normalizeDeviceId,
  normalizeDeviceStatus,
  normalizeVerificationCodeHash,
  getDevicesByInboxId,
  getDeviceByInboxDeviceId,
  getRequiredDeviceShareRequestByRowId,
  getReadableInbox,
  getOwnedInbox,
  getOwnedDevice,
  isPendingDeviceShareRequest,
  invalidatePendingDeviceShareRequests,
  insertDeviceKeyBundle,
} = model;
type DeviceRow = model.DeviceRow;
type DeviceShareRequestRow = model.DeviceShareRequestRow;
export const visibleDeviceShareRequests = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceShareRequestRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const devicesById = new Map(
      getDevicesByInboxId(ctx, inbox.id).map(device => [device.deviceId, device] as const)
    );
    const visibleRequests = Array.from(
      ctx.db.deviceShareRequest.device_share_request_inbox_id.filter(inbox.id)
    ).filter(request => !request.consumedAt && devicesById.has(request.deviceId));

    return visibleRequests
      .map(request => {
        const device = devicesById.get(request.deviceId);
        return {
          id: request.id,
          deviceId: request.deviceId,
          label: device?.label,
          platform: device?.platform,
          clientCreatedAt: request.clientCreatedAt,
          expiresAt: request.expiresAt,
          createdAt: request.createdAt,
          approvedAt: request.approvedAt,
          consumedAt: request.consumedAt,
        };
      });
  }
);

export const resolveDeviceShareRequestByCode = spacetimedb.procedure(
  {
    verificationCodeHash: t.string(),
  },
  t.array(ResolvedDeviceShareRequestRow),
  (ctx, { verificationCodeHash }) => {
    return ctx.withTx(tx => {
      const inbox = getOwnedInbox(tx);
      const allowed = enforceRateLimit(tx, {
        bucketKey: `device_share_resolve:${ctx.sender.toHexString()}`,
        action: 'device_share_resolve',
        ownerIdentity: ctx.sender,
        now: ctx.timestamp,
        windowMs: DEVICE_SHARE_RESOLVE_RATE_WINDOW_MS,
        maxCount: DEVICE_SHARE_RESOLVE_RATE_MAX_PER_WINDOW,
      });
      if (!allowed) {
        return [];
      }
      const normalizedVerificationCodeHash =
        normalizeVerificationCodeHash(verificationCodeHash);
      let resolved:
        | {
            request: DeviceShareRequestRow;
            device: DeviceRow;
          }
        | undefined;
      for (const candidate of tx.db.deviceShareRequest.device_share_request_verification_code_hash.filter(
        normalizedVerificationCodeHash
      )) {
        if (
          candidate.inboxId !== inbox.id ||
          candidate.approvedAt ||
          candidate.consumedAt ||
          isTimestampExpired(candidate.expiresAt, ctx.timestamp)
        ) {
          continue;
        }

        const candidateDevice = getDeviceByInboxDeviceId(tx, inbox.id, candidate.deviceId);
        if (
          candidateDevice &&
          candidateDevice.inboxId === inbox.id &&
          !candidateDevice.revokedAt &&
          candidateDevice.status !== 'revoked'
        ) {
          resolved = { request: candidate, device: candidateDevice };
          break;
        }
      }

      if (!resolved) {
        return [];
      }

      const { request, device } = resolved;

      return [
        {
          requestId: request.id,
          deviceId: device.deviceId,
          label: device.label,
          platform: device.platform,
          deviceEncryptionPublicKey: device.deviceEncryptionPublicKey,
          deviceEncryptionKeyVersion: device.deviceEncryptionKeyVersion,
          deviceEncryptionAlgorithm: device.deviceEncryptionAlgorithm,
          clientCreatedAt: request.clientCreatedAt,
          expiresAt: request.expiresAt,
          createdAt: request.createdAt,
        },
      ];
    });
  }
);

export const createDeviceShareRequest = spacetimedb.reducer(
  {
    deviceId: t.string(),
    verificationCodeHash: t.string(),
    clientCreatedAt: t.timestamp(),
  },
  (ctx, { deviceId, verificationCodeHash, clientCreatedAt }) => {
    const device = getOwnedDevice(ctx, normalizeDeviceId(deviceId));
    const normalizedVerificationCodeHash =
      normalizeVerificationCodeHash(verificationCodeHash);
    const maxAgeMicros = durationMillisecondsToMicros(DEVICE_SHARE_REQUEST_MAX_AGE_MS);
    const maxFutureSkewMicros = durationMillisecondsToMicros(
      DEVICE_SHARE_REQUEST_MAX_FUTURE_SKEW_MS
    );
    const createdMicros = clientCreatedAt.microsSinceUnixEpoch;
    const nowMicros = ctx.timestamp.microsSinceUnixEpoch;

    if (device.revokedAt || device.status === 'revoked') {
      throw new SenderError('Revoked devices cannot create new share requests');
    }
    if (createdMicros < nowMicros - maxAgeMicros) {
      throw new SenderError(
        'Device share request is too old. Generate a new emoji share code and try again.'
      );
    }
    if (createdMicros > nowMicros + maxFutureSkewMicros) {
      throw new SenderError(
        'Device share request is too far in the future. Check the requesting device clock and try again.'
      );
    }

    invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);

    ctx.db.deviceShareRequest.insert({
      id: 0n,
      deviceId: device.deviceId,
      inboxId: device.inboxId,
      verificationCodeHash: normalizedVerificationCodeHash,
      clientCreatedAt,
      expiresAt: timestampPlusMilliseconds(clientCreatedAt, DEVICE_SHARE_REQUEST_EXPIRY_MS),
      createdAt: ctx.timestamp,
      approvedAt: undefined,
      consumedAt: undefined,
    });

    ctx.db.device.id.update({
      ...device,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);

export const approveDeviceShare = spacetimedb.reducer(
  {
    requestId: t.u64(),
      sourceDeviceId: t.string().optional(),
      sourceEncryptionPublicKey: t.string(),
      sourceEncryptionKeyVersion: t.string(),
      sourceEncryptionAlgorithm: t.string().optional(),
      bundleCiphertext: t.string(),
    bundleIv: t.string(),
    bundleAlgorithm: t.string(),
    sharedAgentCount: t.u64(),
    sharedKeyVersionCount: t.u64(),
    expiresAt: t.timestamp(),
  },
  (
    ctx,
    {
      requestId,
        sourceDeviceId,
        sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm,
        bundleCiphertext,
      bundleIv,
      bundleAlgorithm,
      sharedAgentCount,
      sharedKeyVersionCount,
      expiresAt,
    }
	  ) => {
	    const request = getRequiredDeviceShareRequestByRowId(ctx, requestId);
	    const device = getOwnedDevice(ctx, request.deviceId);
	    if (request.inboxId !== device.inboxId) {
	      throw new SenderError('Device share request does not belong to this inbox');
	    }

	    if (!isPendingDeviceShareRequest(request, ctx.timestamp)) {
      throw new SenderError('Device share request is no longer pending');
    }
    if (device.revokedAt || device.status === 'revoked') {
      throw new SenderError('Target device is revoked');
    }

    const normalizedSourceDeviceId = sourceDeviceId?.trim() || undefined;
    if (normalizedSourceDeviceId) {
      const sourceDevice = getOwnedDevice(ctx, normalizedSourceDeviceId);
      if (sourceDevice.revokedAt || sourceDevice.status === 'revoked') {
        throw new SenderError('Source device is revoked');
      }
      if (sourceDevice.status !== 'approved' || !sourceDevice.approvedAt) {
        throw new SenderError('Source device must be approved before it can share keys');
      }
      if (sourceDevice.deviceId === device.deviceId) {
        throw new SenderError('Source device cannot be the target device');
      }
    }

    insertDeviceKeyBundle(ctx, {
      deviceId: device.deviceId,
        sourceDeviceId: normalizedSourceDeviceId,
        sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm,
        bundleCiphertext,
      bundleIv,
      bundleAlgorithm,
        sharedAgentCount,
        sharedKeyVersionCount,
        expiresAt,
        expiryMode: DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES,
      });

    ctx.db.deviceShareRequest.id.update({
      ...request,
      approvedAt: ctx.timestamp,
      consumedAt: ctx.timestamp,
    });

    ctx.db.device.id.update({
      ...device,
      status: normalizeDeviceStatus('approved'),
      approvedAt: device.approvedAt ?? ctx.timestamp,
      revokedAt: undefined,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);
