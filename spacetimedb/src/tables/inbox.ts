import { table, t } from 'spacetimedb/server';

export const inboxTable = table(
    {
      name: 'inbox',
      indexes: [
        {
          accessor: 'inbox_auth_subject',
          algorithm: 'btree',
          columns: ['authSubject'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      normalizedEmail: t.string().unique(),
      displayEmail: t.string(),
      ownerIdentity: t.identity().unique(),
      authSubject: t.string(),
      authIssuer: t.string(),
      authIdentityKey: t.string().unique(),
      authVerified: t.bool(),
      emailAttested: t.bool(),
      authVerifiedAt: t.timestamp(),
      authExpiresAt: t.timestamp().optional(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
    }
);
