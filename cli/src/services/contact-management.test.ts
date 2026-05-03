import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type {
  Agent,
  ContactAllowlistEntry,
  ContactRequest,
  ThreadInvite,
} from '../../../webapp/src/module_bindings/types';
import type { TaskReporter } from './command-runtime';

type ContactRows = {
  actors: Agent[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  allowlistEntries: ContactAllowlistEntry[];
};

function timestamp(microsSinceUnixEpoch: bigint): Timestamp {
  return new Timestamp(microsSinceUnixEpoch);
}

function actor(
  row: Omit<
    Agent,
    | 'masumiRegistrationNetwork'
    | 'masumiInboxAgentId'
    | 'masumiAgentIdentifier'
    | 'masumiRegistrationState'
    | 'publicDescription'
    | 'publicLinkedEmailEnabled'
    | 'allowAllMessageContentTypes'
    | 'allowAllMessageHeaders'
    | 'supportedMessageContentTypes'
    | 'supportedMessageHeaderNames'
  >
): Agent {
  return {
    ...row,
    publicDescription: undefined,
    publicLinkedEmailEnabled: false,
    allowAllMessageContentTypes: false,
    allowAllMessageHeaders: false,
    supportedMessageContentTypes: [],
    supportedMessageHeaderNames: [],
    masumiRegistrationNetwork: undefined,
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: undefined,
  };
}

function contactRequest(
  row: Omit<
    ContactRequest,
    | 'requesterResolvedSortKey'
    | 'targetResolvedSortKey'
    | 'requesterPendingSortKey'
    | 'targetPendingSortKey'
    | 'requesterAccountId'
    | 'targetAccountId'
    | 'resolvedAt'
    | 'resolvedByAgentDbId'
    | 'requesterHiddenAt'
  > &
    Partial<
      Pick<
        ContactRequest,
        | 'requesterResolvedSortKey'
        | 'targetResolvedSortKey'
        | 'requesterPendingSortKey'
        | 'targetPendingSortKey'
        | 'requesterAccountId'
        | 'targetAccountId'
        | 'resolvedAt'
        | 'resolvedByAgentDbId'
        | 'requesterHiddenAt'
      >
    >
): ContactRequest {
  return {
    ...row,
    requesterAccountId: row.requesterAccountId ?? 20n,
    targetAccountId: row.targetAccountId ?? 10n,
    requesterResolvedSortKey: row.requesterResolvedSortKey ?? 0n,
    targetResolvedSortKey: row.targetResolvedSortKey ?? 0n,
    requesterPendingSortKey: row.requesterPendingSortKey ?? 0n,
    targetPendingSortKey: row.targetPendingSortKey ?? 0n,
    resolvedAt: row.resolvedAt,
    resolvedByAgentDbId: row.resolvedByAgentDbId,
    requesterHiddenAt: row.requesterHiddenAt,
  };
}

const reporter: TaskReporter = {
  info() {},
  success() {},
  verbose() {},
};

describe('resolveContactRequest', () => {
  it('approves requests for a secondary owned actor without falling back to the default actor', async () => {
    vi.resetModules();

    const defaultActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'sebastian@example.com',
      slug: 'sebastian-kuepers-gmail-com',
      isDefault: true,
      publicIdentity: 'seb',
      displayName: 'Sebastian',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const lisaActor = actor({
      id: 2n,
      accountId: 10n,
      email: 'sebastian@example.com',
      slug: 'lisa-kuepers',
      isDefault: false,
      publicIdentity: 'lisa',
      displayName: 'Lisa',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const pendingRequest = contactRequest({
      id: 42n,
      threadId: 100n,
      requesterAgentDbId: 9n,
      requesterPublicIdentity: 'external',
      requesterSlug: 'external-agent',
      targetAgentDbId: lisaActor.id,
      targetPublicIdentity: lisaActor.publicIdentity,
      targetSlug: lisaActor.slug,
      status: { tag: 'Pending' as const },
      createdAt: timestamp(2n),
      updatedAt: timestamp(3n),
    });
    const approvedRequest = contactRequest({
      ...pendingRequest,
      status: { tag: 'Approved' as const },
      resolvedAt: timestamp(4n),
    });
    let rows: ContactRows = {
      actors: [defaultActor, lisaActor],
      contactRequests: [pendingRequest],
      threadInvites: [],
      allowlistEntries: [],
    };
    const approveContactRequest = vi.fn(async () => {
      rows = {
        ...rows,
        contactRequests: [approvedRequest],
      };
    });
    const rejectContactRequest = vi.fn(async () => {});
    const unsubscribe = vi.fn();

    vi.doMock('./auth', () => ({
      ensureAuthenticatedSession: vi.fn(async () => ({
        profile: {
          name: 'default',
          spacetimeHost: 'ws://localhost:3000',
          spacetimeDbName: 'agentmessenger-dev',
        },
        session: {
          idToken: 'id-token',
        },
        claims: {
          email: 'sebastian@example.com',
        },
      })),
    }));
    vi.doMock('./spacetimedb', () => ({
      connectAuthenticated: vi.fn(async () => ({
        conn: {
          reducers: {
            approveContactRequest,
            rejectContactRequest,
          },
        },
      })),
      disconnectConnection: vi.fn(),
      readContactRows: vi.fn(() => rows),
      subscribeContactTables: vi.fn(async () => ({
        unsubscribe,
      })),
    }));

    const { resolveContactRequest } = await import('./contact-management');

    const result = await resolveContactRequest({
      profileName: 'default',
      reporter,
      requestId: '#42',
      action: 'approve',
    });

    expect(approveContactRequest).toHaveBeenCalledWith({
      agentDbId: lisaActor.id,
      requestId: pendingRequest.id,
    });
    expect(rejectContactRequest).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      profile: 'default',
      requestId: '42',
      status: 'approved',
      slug: 'lisa-kuepers',
    });
  });
});

describe('cancelContactRequest', () => {
  it('hides rejected outgoing requests fetched through the request lookup procedure', async () => {
    vi.resetModules();

    const defaultActor = actor({
      id: 1n,
      accountId: 10n,
      email: 'sebastian@example.com',
      slug: 'sebastian-kuepers-gmail-com',
      isDefault: true,
      publicIdentity: 'seb',
      displayName: 'Sebastian',
      currentKeyBundleVersion: 1,
      createdAt: timestamp(1n),
      updatedAt: timestamp(1n),
    });
    const rejectedRequest = contactRequest({
      id: 43n,
      threadId: 101n,
      requesterAgentDbId: defaultActor.id,
      requesterPublicIdentity: defaultActor.publicIdentity,
      requesterSlug: defaultActor.slug,
      targetAgentDbId: 9n,
      targetPublicIdentity: 'external',
      targetSlug: 'external-agent',
      status: { tag: 'Rejected' as const },
      createdAt: timestamp(2n),
      updatedAt: timestamp(3n),
      resolvedAt: timestamp(4n),
      resolvedByAgentDbId: 9n,
    });
    const rows: ContactRows = {
      actors: [defaultActor],
      contactRequests: [],
      threadInvites: [],
      allowlistEntries: [],
    };
    let hidden = false;
    const cancelContactRequestReducer = vi.fn(async () => {
      hidden = true;
    });
    const readContactRequest = vi.fn(async () => hidden ? [] : [rejectedRequest]);
    const unsubscribe = vi.fn();

    vi.doMock('./auth', () => ({
      ensureAuthenticatedSession: vi.fn(async () => ({
        profile: {
          name: 'default',
          spacetimeHost: 'ws://localhost:3000',
          spacetimeDbName: 'agentmessenger-dev',
        },
        session: {
          idToken: 'id-token',
        },
        claims: {
          email: 'sebastian@example.com',
        },
      })),
    }));
    vi.doMock('./spacetimedb', () => ({
      connectAuthenticated: vi.fn(async () => ({
        conn: {
          procedures: {
            readContactRequest,
          },
          reducers: {
            cancelContactRequest: cancelContactRequestReducer,
          },
        },
      })),
      disconnectConnection: vi.fn(),
      readContactRows: vi.fn(() => rows),
      subscribeContactTables: vi.fn(async () => ({
        unsubscribe,
      })),
    }));

    const { cancelContactRequest } = await import('./contact-management');

    const result = await cancelContactRequest({
      profileName: 'default',
      reporter,
      requestId: '#43',
    });

    expect(readContactRequest).toHaveBeenCalledWith({ requestId: rejectedRequest.id });
    expect(cancelContactRequestReducer).toHaveBeenCalledWith({
      agentDbId: defaultActor.id,
      requestId: rejectedRequest.id,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      profile: 'default',
      requestId: '43',
      status: 'canceled',
      slug: 'external-agent',
    });
  });
});
