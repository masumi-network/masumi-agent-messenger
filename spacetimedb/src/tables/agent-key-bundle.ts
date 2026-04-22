import { table, t } from 'spacetimedb/server';

export const agentKeyBundleTable = table(
    {
      name: 'agent_key_bundle',
      indexes: [
        {
          accessor: 'agent_key_bundle_agent_db_id',
          algorithm: 'btree',
          columns: ['agentDbId'],
        },
        {
          accessor: 'agent_key_bundle_public_identity',
          algorithm: 'btree',
          columns: ['publicIdentity'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      agentDbId: t.u64(),
      publicIdentity: t.string(),
      uniqueKey: t.string().unique(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string(),
      createdAt: t.timestamp(),
    }
);
