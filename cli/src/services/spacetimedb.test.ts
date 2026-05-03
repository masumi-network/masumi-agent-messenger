import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import type {
  AccountChangeSignal,
  Agent,
  Thread,
  ThreadParticipantPreview,
} from '../../../webapp/src/module_bindings/types';
import {
  connectAuthenticated,
  disconnectConnection,
  readShellRows,
  withSpacetimeOperationTimeout,
  withExistingAuthenticatedConnection,
} from './spacetimedb';

function fakeConnection(): DbConnection {
  return {
    reducers: {
      refreshAccountAuthLease: vi.fn(async () => {}),
    },
    disconnect: vi.fn(),
  } as unknown as DbConnection;
}

describe('borrowed SpacetimeDB connections', () => {
  it('returns the existing authenticated connection inside the borrow scope', async () => {
    const conn = fakeConnection();

    const connected = await withExistingAuthenticatedConnection(
      {
        conn,
        host: 'http://localhost:3000',
        databaseName: 'agentmessenger-dev',
        sessionToken: 'token-1',
      },
      () =>
        connectAuthenticated({
          host: 'http://localhost:3000',
          databaseName: 'agentmessenger-dev',
          sessionToken: 'token-1',
        })
    );

    expect(connected.conn).toBe(conn);
    expect(conn.reducers.refreshAccountAuthLease).toHaveBeenCalledTimes(1);
    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('does not disconnect a borrowed connection inside the borrow scope', async () => {
    const conn = fakeConnection();

    await withExistingAuthenticatedConnection(
      {
        conn,
        host: 'http://localhost:3000',
        databaseName: 'agentmessenger-dev',
        sessionToken: 'token-1',
      },
      async () => {
        disconnectConnection(conn);
      }
    );

    expect(conn.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects the same connection outside the borrow scope', () => {
    const conn = fakeConnection();

    disconnectConnection(conn);

    expect(conn.disconnect).toHaveBeenCalledTimes(1);
  });

  it('times out a stale borrowed lease refresh instead of hanging the caller', async () => {
    vi.useFakeTimers();
    try {
      const conn = {
        reducers: {
          refreshAccountAuthLease: vi.fn(() => new Promise<void>(() => {})),
        },
        disconnect: vi.fn(),
      } as unknown as DbConnection;

      const connected = withExistingAuthenticatedConnection(
        {
          conn,
          host: 'http://localhost:3000',
          databaseName: 'agentmessenger-dev',
          sessionToken: 'token-1',
        },
        () =>
          connectAuthenticated({
            host: 'http://localhost:3000',
            databaseName: 'agentmessenger-dev',
            sessionToken: 'token-1',
          })
      );
      const handled = connected.then(
        () => null,
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(10000);
      await expect(handled).resolves.toMatchObject({
        code: 'SPACETIMEDB_AUTH_LEASE_REFRESH_TIMEOUT',
        exitCode: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SpacetimeDB operation timeouts', () => {
  it('rejects operations that never settle', async () => {
    vi.useFakeTimers();
    try {
      const operation = withSpacetimeOperationTimeout(
        {
          label: 'test reducer',
          timeoutMs: 100,
          code: 'SPACETIMEDB_TEST_TIMEOUT',
        },
        () => new Promise<void>(() => {})
      );
      const handled = operation.then(
        () => null,
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(handled).resolves.toMatchObject({
        code: 'SPACETIMEDB_TEST_TIMEOUT',
        exitCode: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shell procedure cache', () => {
  it('publishes procedure-backed thread snapshots into shell rows', async () => {
    const now = new Timestamp(1n);
    const actor = {
      id: 10n,
      accountId: 1n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent-public',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
    } as Agent;
    const peer = {
      id: 20n,
      accountId: 2n,
      email: 'peer@example.com',
      slug: 'peer',
      isDefault: true,
      publicIdentity: 'peer-public',
      displayName: 'Peer',
      currentKeyBundleVersion: 1,
    } as Agent;
    const thread = {
      id: 100n,
      kind: { tag: 'Direct' },
      directLowAgentDbId: 10n,
      directHighAgentDbId: 20n,
      title: undefined,
      creatorAgentDbId: 10n,
      membershipVersion: 1n,
      activeParticipantCount: 2n,
      lastMessageId: 5n,
      messageCount: 2n,
      lastMessageAt: now,
      messageRetentionMs: undefined,
      createdAt: now,
      updatedAt: now,
    } as Thread;
    const participant = {
      id: 1000n,
      threadId: thread.id,
      agentDbId: actor.id,
      accountId: actor.accountId,
      membershipVersion: 1n,
      lastSentSeq: 0n,
      lastSentSecretVersion: 1,
      lastReadMessageId: 0n,
      archived: false,
      isAdmin: true,
      active: true,
      createdAt: now,
    } as ThreadParticipantPreview;
    const table = <Row,>(rows: Row[]) => ({
      iter: () => rows[Symbol.iterator](),
    });
    const conn = {
      db: {
        visible_account_change_signal: table([
          {
            id: 1n,
            accountId: 1n,
            ownedAgentsVersion: 1n,
            ownedDevicesVersion: 1n,
            contactRequestsVersion: 1n,
            threadInvitesVersion: 1n,
            contactAllowlistVersion: 1n,
            channelJoinRequestsVersion: 1n,
            threadListVersion: 1n,
            createdAt: now,
            updatedAt: now,
          } as AccountChangeSignal,
        ]),
        visible_accounts: table([]),
        visible_device_share_requests: table([]),
        visible_device_key_bundles: table([]),
        visible_channels: table([]),
        visible_channel_memberships: table([]),
      },
      procedures: {
        listOwnedAgentsPage: vi.fn(async () => ({
          agents: [actor],
          nextAfterId: undefined,
        })),
        listOwnedDevices: vi.fn(async () => []),
        listContactAllowlistEntries: vi.fn(async () => []),
        listPendingContactRequestsPage: vi.fn(async () => ({
          contactRequests: [],
          nextAfterSortKey: undefined,
        })),
        listPendingThreadInvitesPage: vi.fn(async () => ({
          threadInvites: [],
          nextAfterSortKey: undefined,
        })),
        listPendingChannelJoinRequestsPage: vi.fn(async () => ({
          joinRequests: [],
          nextAfterSortKey: undefined,
        })),
        listVisibleThreads: vi.fn(async () => ({
          actors: [actor, peer],
          participantPreviews: [participant],
          threads: [thread],
          nextAfterSortKey: undefined,
        })),
      },
    } as unknown as DbConnection;

    const rows = await readShellRows(conn, { actorSlug: 'agent' });

    expect(rows.actors.map(row => row.slug)).toEqual(['agent', 'peer']);
    expect(rows.participants).toEqual([participant]);
    expect(rows.readStates).toEqual([participant]);
    expect(rows.threads).toEqual([thread]);
    expect(rows.threadSignals).toEqual([thread]);
  });

  it('does not reuse an empty bootstrap cache for later table updates', async () => {
    const now = new Timestamp(1n);
    const actor = {
      id: 10n,
      accountId: 1n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent-public',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
    } as Agent;
    const listOwnedAgentsPage = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [],
        nextAfterId: undefined,
      })
      .mockResolvedValueOnce({
        agents: [actor],
        nextAfterId: undefined,
      });
    const table = <Row,>(rows: Row[]) => ({
      iter: () => rows[Symbol.iterator](),
    });
    const conn = {
      db: {
        visible_account_change_signal: table([
          {
            id: 1n,
            accountId: 1n,
            ownedAgentsVersion: 1n,
            ownedDevicesVersion: 1n,
            contactRequestsVersion: 1n,
            threadInvitesVersion: 1n,
            contactAllowlistVersion: 1n,
            channelJoinRequestsVersion: 1n,
            threadListVersion: 1n,
            createdAt: now,
            updatedAt: now,
          } as AccountChangeSignal,
        ]),
        visible_accounts: table([]),
        visible_device_share_requests: table([]),
        visible_device_key_bundles: table([]),
        visible_channels: table([]),
        visible_channel_memberships: table([]),
      },
      procedures: {
        listOwnedAgentsPage,
        listOwnedDevices: vi.fn(async () => []),
        listContactAllowlistEntries: vi.fn(async () => []),
        listPendingContactRequestsPage: vi.fn(async () => ({
          contactRequests: [],
          nextAfterSortKey: undefined,
        })),
        listPendingThreadInvitesPage: vi.fn(async () => ({
          threadInvites: [],
          nextAfterSortKey: undefined,
        })),
        listPendingChannelJoinRequestsPage: vi.fn(async () => ({
          joinRequests: [],
          nextAfterSortKey: undefined,
        })),
        listVisibleThreads: vi.fn(async () => ({
          actors: [],
          participantPreviews: [],
          threads: [],
          nextAfterSortKey: undefined,
        })),
      },
    } as unknown as DbConnection;

    await expect(readShellRows(conn, { actorSlug: 'agent' })).resolves.toMatchObject({
      actors: [],
    });
    await expect(
      readShellRows(conn, {
        actorSlug: 'agent',
        changedAccessor: 'visible_accounts',
      })
    ).resolves.toMatchObject({
      actors: [actor],
    });

    expect(listOwnedAgentsPage).toHaveBeenCalledTimes(2);
  });

  it('reuses cached procedure slices for non-signal table updates', async () => {
    let signal: AccountChangeSignal = {
      id: 1n,
      accountId: 1n,
      ownedAgentsVersion: 1n,
      ownedDevicesVersion: 1n,
      contactRequestsVersion: 1n,
      threadInvitesVersion: 1n,
      contactAllowlistVersion: 1n,
      channelJoinRequestsVersion: 1n,
      threadListVersion: 1n,
      createdAt: new Timestamp(1n),
      updatedAt: new Timestamp(1n),
    };
    const actor = {
      id: 10n,
      accountId: 1n,
      email: 'agent@example.com',
      slug: 'agent',
      isDefault: true,
      publicIdentity: 'agent-public',
      displayName: 'Agent',
      currentKeyBundleVersion: 1,
    } as Agent;
    const listOwnedAgentsPage = vi.fn(async () => ({
      agents: [actor],
      nextAfterId: undefined,
    }));
    const listOwnedDevices = vi.fn(async () => []);
    const listContactAllowlistEntries = vi.fn(async () => []);
    const listPendingContactRequestsPage = vi.fn(async () => ({
      contactRequests: [],
      nextAfterSortKey: undefined,
    }));
    const listPendingThreadInvitesPage = vi.fn(async () => ({
      threadInvites: [],
      nextAfterSortKey: undefined,
    }));
    const listPendingChannelJoinRequestsPage = vi.fn(async () => ({
      joinRequests: [],
      nextAfterSortKey: undefined,
    }));
    const listVisibleThreads = vi.fn(async () => ({
      actors: [],
      participantPreviews: [],
      readStates: [],
      threads: [],
      nextAfterSortKey: undefined,
    }));
    const table = <Row,>(rows: () => Row[]) => ({
      iter: () => rows()[Symbol.iterator](),
    });
    const conn = {
      db: {
        visible_account_change_signal: table(() => [signal]),
        visible_accounts: table(() => []),
        visible_device_share_requests: table(() => []),
        visible_device_key_bundles: table(() => []),
        visible_channels: table(() => []),
        visible_channel_memberships: table(() => []),
      },
      procedures: {
        listOwnedAgentsPage,
        listOwnedDevices,
        listContactAllowlistEntries,
        listPendingContactRequestsPage,
        listPendingThreadInvitesPage,
        listPendingChannelJoinRequestsPage,
        listVisibleThreads,
      },
    } as unknown as DbConnection;

    await readShellRows(conn, { actorSlug: 'agent' });
    await readShellRows(conn, {
      actorSlug: 'agent',
      changedAccessor: 'visible_channels',
    });

    expect(listOwnedAgentsPage).toHaveBeenCalledTimes(1);
    expect(listOwnedDevices).toHaveBeenCalledTimes(1);
    expect(listContactAllowlistEntries).toHaveBeenCalledTimes(1);
    expect(listPendingContactRequestsPage).toHaveBeenCalledTimes(1);
    expect(listPendingThreadInvitesPage).toHaveBeenCalledTimes(1);
    expect(listPendingChannelJoinRequestsPage).toHaveBeenCalledTimes(1);
    expect(listVisibleThreads).toHaveBeenCalledTimes(1);

    signal = {
      ...signal,
      contactRequestsVersion: 2n,
      updatedAt: new Timestamp(2n),
    };
    await readShellRows(conn, {
      actorSlug: 'agent',
      changedAccessor: 'visible_account_change_signal',
    });

    expect(listOwnedAgentsPage).toHaveBeenCalledTimes(1);
    expect(listOwnedDevices).toHaveBeenCalledTimes(1);
    expect(listContactAllowlistEntries).toHaveBeenCalledTimes(1);
    expect(listPendingContactRequestsPage).toHaveBeenCalledTimes(2);
    expect(listPendingThreadInvitesPage).toHaveBeenCalledTimes(1);
    expect(listPendingChannelJoinRequestsPage).toHaveBeenCalledTimes(1);
    expect(listVisibleThreads).toHaveBeenCalledTimes(1);
  });
});
