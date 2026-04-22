import { table, t } from 'spacetimedb/server';

import { getScheduledReducer } from '../scheduled';

export const inboxAuthLeaseExpiryTable = table(
  {
    name: 'inbox_auth_lease_expiry',
    indexes: [
      {
        accessor: 'inbox_auth_lease_expiry_lease_id',
        algorithm: 'btree',
        columns: ['leaseId'],
      },
    ],
    scheduled: (): any => getScheduledReducer('expireInboxAuthLease'),
  },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    leaseId: t.u64(),
    ownerIdentity: t.identity(),
    expiresAt: t.timestamp(),
    createdAt: t.timestamp(),
  }
);
