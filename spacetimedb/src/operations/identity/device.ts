import { t } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleDeviceRow,
  normalizeDeviceId,
  normalizeDeviceStatus,
  getDevicesByInboxId,
  getReadableInbox,
  getOwnedInbox,
  getOwnedDevice,
  upsertInboxDevice,
  invalidatePendingDeviceShareRequests,
  invalidatePendingDeviceKeyBundles,
} = model;
export const visibleDevices = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getDevicesByInboxId(ctx, inbox.id);
  }
);

export const registerDevice = spacetimedb.reducer(
  {
    deviceId: t.string(),
    label: t.string().optional(),
      platform: t.string().optional(),
      deviceEncryptionPublicKey: t.string(),
      deviceEncryptionKeyVersion: t.string(),
      deviceEncryptionAlgorithm: t.string().optional(),
    },
    (
      ctx,
      {
        deviceId,
        label,
        platform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      }
    ) => {
      const inbox = getOwnedInbox(ctx);
      upsertInboxDevice(ctx, inbox.id, {
        deviceId,
        label,
        platform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      });
    }
);

export const revokeDevice = spacetimedb.reducer(
  {
    deviceId: t.string(),
  },
  (ctx, { deviceId }) => {
    const device = getOwnedDevice(ctx, normalizeDeviceId(deviceId));
    if (device.revokedAt && device.status === 'revoked') {
      return;
    }

    invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);
    invalidatePendingDeviceKeyBundles(ctx, device.inboxId, device.deviceId);

    ctx.db.device.id.update({
      ...device,
      status: normalizeDeviceStatus('revoked'),
      revokedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastSeenAt: ctx.timestamp,
    });
  }
);
