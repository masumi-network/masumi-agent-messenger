import { table, t } from 'spacetimedb/server';

export const agentTable = table(
    {
      name: 'agent',
      indexes: [
        {
          accessor: 'agent_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'agent_normalized_email',
          algorithm: 'btree',
          columns: ['normalizedEmail'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      normalizedEmail: t.string(),
      slug: t.string().unique(),
      inboxIdentifier: t.string().optional(),
      isDefault: t.bool(),
      publicIdentity: t.string().unique(),
      displayName: t.string().optional(),
      publicLinkedEmailEnabled: t.bool(),
      publicDescription: t.string().optional(),
      allowAllMessageContentTypes: t.bool().optional(),
      allowAllMessageHeaders: t.bool().optional(),
      supportedMessageContentTypes: t.array(t.string()).optional(),
      supportedMessageHeaderNames: t.array(t.string()).optional(),
      currentEncryptionPublicKey: t.string(),
      currentEncryptionKeyVersion: t.string(),
      currentEncryptionAlgorithm: t.string(),
      currentSigningPublicKey: t.string(),
      currentSigningKeyVersion: t.string(),
      currentSigningAlgorithm: t.string(),
      masumiRegistrationNetwork: t.string().optional(),
      masumiInboxAgentId: t.string().optional(),
      masumiAgentIdentifier: t.string().optional(),
      masumiRegistrationState: t.string().optional(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
    }
);
