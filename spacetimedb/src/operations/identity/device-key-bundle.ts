import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import { deviceKeyBundleExpiryTable } from '../../tables/device-key-bundle-expiry';

import * as model from '../../model';

const {
  VisibleDeviceKeyBundleRow,
  ClaimedDeviceKeyBundleRow,
  compareTimestamp,
  isTimestampExpired,
  normalizeDeviceId,
  getDevicesByInboxId,
  getReadableInbox,
  getOwnedDevice,
  isNeverExpiringDeviceKeyBundle,
  isClaimableDeviceKeyBundle,
} = model;
export const visibleDeviceKeyBundles = spacetimedb.view(
  { public: true },
  t.array(VisibleDeviceKeyBundleRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const deviceIds = new Set(getDevicesByInboxId(ctx, inbox.id).map(device => device.deviceId));
    return Array.from(ctx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(inbox.id))
      .filter(bundle => !bundle.consumedAt && deviceIds.has(bundle.targetDeviceId))
      .map(bundle => ({
        id: bundle.id,
        targetDeviceId: bundle.targetDeviceId,
        sourceDeviceId: bundle.sourceDeviceId,
        sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
        sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
        sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
        bundleAlgorithm: bundle.bundleAlgorithm,
        sharedAgentCount: bundle.sharedAgentCount,
        sharedKeyVersionCount: bundle.sharedKeyVersionCount,
        createdAt: bundle.createdAt,
        expiresAt: bundle.expiresAt,
        consumedAt: bundle.consumedAt,
        expiryMode: bundle.expiryMode,
      }));
  }
);

export const expireDeviceKeyBundle = spacetimedb.reducer(
  { arg: deviceKeyBundleExpiryTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const bundle = ctx.db.deviceKeyBundle.id.find(arg.bundleId);
    ctx.db.deviceKeyBundleExpiry.delete(arg);
    if (!bundle || bundle.consumedAt || isNeverExpiringDeviceKeyBundle(bundle)) {
      return;
    }
    if (
      bundle.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(bundle.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    ctx.db.deviceKeyBundle.id.update({
      ...bundle,
      consumedAt: ctx.timestamp,
    });
  }
);

export const claimDeviceKeyBundle = spacetimedb.procedure(
  {
    deviceId: t.string(),
  },
  t.array(ClaimedDeviceKeyBundleRow),
  (ctx, { deviceId }) => {
    return ctx.withTx(tx => {
      const device = getOwnedDevice(tx, normalizeDeviceId(deviceId));
      if (device.revokedAt || device.status === 'revoked') {
        throw new SenderError('Device is revoked and cannot claim new key shares');
      }
      if (device.status !== 'approved' || !device.approvedAt) {
        throw new SenderError('Device is pending approval and cannot claim new key shares');
      }

      const claimableBundles = Array.from(
        tx.db.deviceKeyBundle.device_key_bundle_inbox_id.filter(device.inboxId)
      )
        .filter(bundle => bundle.targetDeviceId === device.deviceId)
        .filter(bundle => isClaimableDeviceKeyBundle(bundle, ctx.timestamp))
        .sort((left, right) => {
          const timeOrder = compareTimestamp(left.createdAt, right.createdAt);
          if (timeOrder !== 0) return timeOrder;
          return Number(left.id - right.id);
        });

      const bundle =
        claimableBundles.length > 0
          ? claimableBundles[claimableBundles.length - 1]
          : undefined;
      if (!bundle) {
        return [];
      }

      tx.db.deviceKeyBundle.id.update({
        ...bundle,
        consumedAt: ctx.timestamp,
      });

      tx.db.device.id.update({
        ...device,
        lastSeenAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });

      return [
        {
          bundleId: bundle.id,
          targetDeviceId: bundle.targetDeviceId,
            sourceDeviceId: bundle.sourceDeviceId,
            sourceEncryptionPublicKey: bundle.sourceEncryptionPublicKey,
            sourceEncryptionKeyVersion: bundle.sourceEncryptionKeyVersion,
            sourceEncryptionAlgorithm: bundle.sourceEncryptionAlgorithm,
            bundleCiphertext: bundle.bundleCiphertext,
          bundleIv: bundle.bundleIv,
          bundleAlgorithm: bundle.bundleAlgorithm,
          sharedAgentCount: bundle.sharedAgentCount,
          sharedKeyVersionCount: bundle.sharedKeyVersionCount,
          createdAt: bundle.createdAt,
          expiresAt: bundle.expiresAt,
          expiryMode: bundle.expiryMode,
        },
      ];
    });
  }
);
