import { table, t } from 'spacetimedb/server';

export const deviceTable = table(
    {
      name: 'device',
      indexes: [
        {
          accessor: 'device_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      deviceId: t.string(),
      inboxId: t.u64(),
      uniqueKey: t.string().unique(),
      label: t.string().optional(),
      platform: t.string().optional(),
      deviceEncryptionPublicKey: t.string(),
      deviceEncryptionKeyVersion: t.string(),
      deviceEncryptionAlgorithm: t.string(),
      status: t.string(),
      approvedAt: t.timestamp().optional(),
      revokedAt: t.timestamp().optional(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      lastSeenAt: t.timestamp(),
    }
);
