import { table, t } from 'spacetimedb/server';

import { getScheduledReducer } from '../scheduled';

export const deviceKeyBundleExpiryTable = table(
  {
    name: 'device_key_bundle_expiry',
    indexes: [
      {
        accessor: 'device_key_bundle_expiry_bundle_id',
        algorithm: 'btree',
        columns: ['bundleId'],
      },
    ],
    scheduled: (): any => getScheduledReducer('expireDeviceKeyBundle'),
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    bundleId: t.u64(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);
