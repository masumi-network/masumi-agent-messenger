import { table, t } from 'spacetimedb/server';

export const inboxAuthLeaseTable = table(
    {
      name: 'inbox_auth_lease',
      indexes: [
        {
          accessor: 'inbox_auth_lease_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      ownerIdentity: t.identity().unique(),
      inboxId: t.u64(),
      authIdentityKey: t.string(),
      normalizedEmail: t.string(),
      authIssuer: t.string(),
      authSubject: t.string(),
      expiresAt: t.timestamp(),
      active: t.bool(),
      updatedAt: t.timestamp(),
    }
);
