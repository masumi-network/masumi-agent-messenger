import { table, t } from 'spacetimedb/server';
import { CONTACT_ALLOWLIST_KINDS } from '../../../shared/contact-policy';

export const contactAllowlistEntryTable = table(
    {
      name: 'contact_allowlist_entry',
      indexes: [
        {
          accessor: 'contact_allowlist_entry_inbox_id',
          algorithm: 'btree',
          columns: ['inboxId'],
        },
        {
          accessor: 'contact_allowlist_entry_agent_public_identity',
          algorithm: 'btree',
          columns: ['agentPublicIdentity'],
        },
        {
          accessor: 'contact_allowlist_entry_normalized_email',
          algorithm: 'btree',
          columns: ['normalizedEmail'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      inboxId: t.u64(),
      kind: t.enum('ContactAllowlistKind', CONTACT_ALLOWLIST_KINDS),
      uniqueKey: t.string().unique(),
      agentPublicIdentity: t.string().optional(),
      agentSlug: t.string().optional(),
      agentDisplayName: t.string().optional(),
      normalizedEmail: t.string().optional(),
      displayEmail: t.string().optional(),
      createdByAgentDbId: t.u64(),
      createdAt: t.timestamp(),
    }
);
