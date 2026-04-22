import { table, t } from 'spacetimedb/server';
import { CONTACT_REQUEST_STATUSES } from '../../../shared/contact-policy';

export const contactRequestTable = table(
    {
      name: 'contact_request',
      indexes: [
        {
          accessor: 'contact_request_thread_id',
          algorithm: 'btree',
          columns: ['threadId'],
        },
        {
          accessor: 'contact_request_requester_agent_db_id',
          algorithm: 'btree',
          columns: ['requesterAgentDbId'],
        },
        {
          accessor: 'contact_request_target_agent_db_id',
          algorithm: 'btree',
          columns: ['targetAgentDbId'],
        },
        {
          accessor: 'contact_request_status',
          algorithm: 'btree',
          columns: ['status'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      threadId: t.u64(),
      requesterAgentDbId: t.u64(),
      requesterPublicIdentity: t.string(),
      requesterSlug: t.string(),
      requesterDisplayName: t.string().optional(),
      requesterNormalizedEmail: t.string(),
      requesterDisplayEmail: t.string(),
      targetAgentDbId: t.u64(),
      targetPublicIdentity: t.string(),
      targetSlug: t.string(),
      targetDisplayName: t.string().optional(),
      status: t.enum('ContactRequestStatus', CONTACT_REQUEST_STATUSES),
      hiddenMessageCount: t.u64(),
      createdAt: t.timestamp(),
      updatedAt: t.timestamp(),
      resolvedAt: t.timestamp().optional(),
      resolvedByAgentDbId: t.u64().optional(),
    }
);
