import { table, t } from 'spacetimedb/server';

export const deviceShareRequestTable = table(
    {
      name: 'device_share_request',
      indexes: [
        {
          accessor: 'device_share_request_device_id',
          algorithm: 'btree',
          columns: ['deviceId'],
        },
        {
          accessor: 'device_share_request_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'device_share_request_verification_code_hash',
          algorithm: 'btree',
          columns: ['verificationCodeHash'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      deviceId: t.string(),
      inboxId: t.u64(),
      verificationCodeHash: t.string(),
      clientCreatedAt: t.timestamp(),
      expiresAt: t.timestamp(),
      createdAt: t.timestamp(),
      approvedAt: t.timestamp().optional(),
      consumedAt: t.timestamp().optional(),
    }
);
