import { table, t } from 'spacetimedb/server';

import {
  DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES,
  DeviceKeyBundleExpiryMode,
} from '../model';

export const deviceKeyBundleTable = table(
    {
      name: 'device_key_bundle',
      indexes: [
        {
          accessor: 'device_key_bundle_target_device_id',
          algorithm: 'btree',
          columns: ['targetDeviceId'],
        },
        {
          accessor: 'device_key_bundle_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      targetDeviceId: t.string(),
      inboxId: t.u64(),
      sourceDeviceId: t.string().optional(),
      sourceEncryptionPublicKey: t.string(),
      sourceEncryptionKeyVersion: t.string(),
      sourceEncryptionAlgorithm: t.string(),
      bundleCiphertext: t.string(),
      bundleIv: t.string(),
      bundleAlgorithm: t.string(),
      sharedAgentCount: t.u64(),
      sharedKeyVersionCount: t.u64(),
      createdAt: t.timestamp(),
      expiresAt: t.timestamp(),
      consumedAt: t.timestamp().optional(),
      expiryMode: DeviceKeyBundleExpiryMode.default(DEVICE_KEY_BUNDLE_EXPIRY_MODE_EXPIRES),
    }
);
