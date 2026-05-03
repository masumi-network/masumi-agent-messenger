import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type {
  Agent,
  ChannelMember,
  Channel,
} from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
  updateChannelSettings: vi.fn(),
  updateChannelMemberPermission: vi.fn(),
  joinPublicChannel: vi.fn(),
  listChannelMessages: vi.fn(),
  listPublicChannelMessages: vi.fn(),
  readOwnedAgent: vi.fn(),
  lookupPublicChannelBySlug: vi.fn(),
  readVisibleChannelState: vi.fn(),
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  iterVisibleAgents: vi.fn(),
  iterPublicChannels: vi.fn(),
  iterVisibleChannels: vi.fn(),
  iterVisibleChannelMemberships: vi.fn(),
  unsubscribe: vi.fn(),
  connectAuthenticated: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
  readAllOwnedAgents: async () => Array.from(mocks.iterVisibleAgents()) as Agent[],
  readPendingChannelJoinRequests: async () => [],
}));

import {
  createChannel,
  joinPublicChannel,
  readAuthenticatedChannelMessages,
  updateChannelMemberPermission,
  updateChannelSettings,
} from './channel';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function actor(row: Partial<Agent> & Pick<Agent, 'id' | 'accountId' | 'slug'>): Agent {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email ?? 'owner@example.com',
    slug: row.slug,
    isDefault: row.isDefault ?? true,
    publicIdentity: row.publicIdentity ?? row.slug,
    displayName: row.displayName,
    currentKeyBundleVersion: row.currentKeyBundleVersion ?? 1,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    publicDescription: row.publicDescription,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes ?? [],
    supportedMessageHeaderNames: row.supportedMessageHeaderNames ?? [],
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  } as Agent;
}

function channel(row: Partial<Channel> & Pick<Channel, 'id' | 'slug'>): Channel {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    accessMode: row.accessMode ?? { tag: 'Public' as const },
    defaultPermission: row.defaultPermission ?? { tag: 'ReadWrite' as const },
    lastMessageId: row.lastMessageId ?? 0n,
    messageCount: row.messageCount ?? 0n,
    discoverable: row.discoverable ?? true,
    publicDiscoverableSortKey: row.publicDiscoverableSortKey ?? 0n,
    publicDiscoverableIdDescSortKey: row.publicDiscoverableIdDescSortKey ?? 0n,
    publicDiscoverablePageSortKey: row.publicDiscoverablePageSortKey ?? '0:0',
    creatorAgentDbId: row.creatorAgentDbId ?? 1n,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    lastMessageAt: row.lastMessageAt ?? timestamp(1n),
  };
}

function membership(
  row: Partial<ChannelMember> &
    Pick<ChannelMember, 'id' | 'channelId' | 'agentDbId'>
): ChannelMember {
  return {
    id: row.id,
    channelId: row.channelId,
    agentDbId: row.agentDbId,
    accountId: row.accountId ?? 10n,
    permission: row.permission ?? { tag: 'Read' },
    active: row.active ?? true,
    activeRecencySortKey: row.activeRecencySortKey ?? 0n,
    lastSentSeq: row.lastSentSeq ?? 0n,
    lastReadMessageId: row.lastReadMessageId ?? 0n,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
  };
}

function makeConnection() {
  return {
    reducers: {
      createChannel: mocks.createChannel,
      updateChannelSettings: mocks.updateChannelSettings,
      updateChannelMemberPermission: mocks.updateChannelMemberPermission,
      joinPublicChannel: mocks.joinPublicChannel,
    },
    procedures: {
      listChannelMessages: mocks.listChannelMessages,
      listPublicChannelMessages: mocks.listPublicChannelMessages,
      readOwnedAgent: mocks.readOwnedAgent,
      lookupPublicChannelBySlug: mocks.lookupPublicChannelBySlug,
      readVisibleChannelState: mocks.readVisibleChannelState,
    },
    db: {
      visible_channels: {
        iter: mocks.iterVisibleChannels,
      },
      visible_channel_memberships: {
        iter: mocks.iterVisibleChannelMemberships,
      },
    },
    subscriptionBuilder() {
      let applied: (() => void) | null = null;
      return {
        onApplied(callback: () => void) {
          applied = callback;
          return this;
        },
        onError() {
          return this;
        },
        subscribe() {
          queueMicrotask(() => applied?.());
          return {
            unsubscribe: mocks.unsubscribe,
          };
        },
      };
    },
  };
}

describe('channel mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.createChannel.mockReset();
    mocks.updateChannelSettings.mockReset();
    mocks.updateChannelMemberPermission.mockReset();
    mocks.joinPublicChannel.mockReset();
    mocks.listChannelMessages.mockReset();
    mocks.listPublicChannelMessages.mockReset();
    mocks.readOwnedAgent.mockReset();
    mocks.lookupPublicChannelBySlug.mockReset();
    mocks.readVisibleChannelState.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.ensureAuthenticatedSession.mockReset();
    mocks.iterVisibleAgents.mockReset();
    mocks.iterPublicChannels.mockReset();
    mocks.iterVisibleChannels.mockReset();
    mocks.iterVisibleChannelMemberships.mockReset();
    mocks.unsubscribe.mockReset();
    mocks.connectAuthenticated.mockReset();
    mocks.ensureAuthenticatedSession.mockResolvedValue({
      profile: {
        name: 'default',
        issuer: 'https://issuer.example.com',
        clientId: 'client-id',
        oidcScope: 'openid profile email',
        spacetimeHost: 'ws://localhost:3000',
        spacetimeDbName: 'agentmessenger-dev',
      },
      session: {
        idToken: 'id-token',
        accessToken: 'access-token',
        expiresAt: 1,
        createdAt: 1,
      },
      claims: {
        email: 'owner@example.com',
      },
    });
    mocks.connectAuthenticated.mockResolvedValue({
      conn: makeConnection(),
    });
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([]);
    mocks.iterVisibleChannelMemberships.mockReturnValue([]);
    mocks.listChannelMessages.mockResolvedValue([]);
    mocks.listPublicChannelMessages.mockResolvedValue([]);
    mocks.readOwnedAgent.mockImplementation(async ({ slug }: { slug?: string }) =>
      (Array.from(mocks.iterVisibleAgents()) as Agent[]).find(actor => actor.slug === slug) ?? null
    );
    mocks.lookupPublicChannelBySlug.mockImplementation(async ({ slug }: { slug?: string }) =>
      (Array.from(mocks.iterPublicChannels()) as Channel[]).find(row => row.slug === slug) ?? null
    );
    mocks.readVisibleChannelState.mockImplementation(
      async ({ channelSlug }: { channelSlug?: string }) => {
        const channel = (Array.from(mocks.iterVisibleChannels()) as Channel[]).find(
          row => channelSlug === undefined || row.slug === channelSlug
        ) ?? null;
        const member =
          channel === null
            ? null
            : ((Array.from(mocks.iterVisibleChannelMemberships()) as ChannelMember[]).find(
                row => row.channelId === channel.id
              ) ?? null);
        return channel ? { channel, member } : null;
      }
    );
  });

  it('refuses channel mutations from an explicit agent with pending deregistration', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
        masumiRegistrationState: { tag: 'PendingDeregistration' as const },
      }),
    ]);

    await expect(
      createChannel({
        profileName: 'default',
        actorSlug: 'owner',
        slug: 'ops',
        accessMode: 'public',
        discoverable: true,
        reporter: {
          info() {},
          success() {},
          verbose() {},
        },
      })
    ).rejects.toMatchObject({
      code: 'AGENT_DEREGISTERED',
    });

    expect(mocks.createChannel).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.disconnectConnection).toHaveBeenCalledOnce();
  });

  it('creates a channel with the new access-mode contract', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);

    await createChannel({
      profileName: 'default',
      actorSlug: 'owner',
      slug: 'ops',
      accessMode: 'public',
      discoverable: true,
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'ops',
        accessMode: { tag: 'Public' },
      })
    );
  });

  it('waits for the joined membership before reporting join permission', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
      }),
    ]);
    mocks.iterPublicChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
      }),
    ]);
    let joined = false;
    let membershipReadsAfterJoin = 0;
    mocks.joinPublicChannel.mockImplementation(async () => {
      joined = true;
    });
    mocks.iterVisibleChannelMemberships.mockImplementation(() => {
      if (!joined) {
        return [];
      }
      membershipReadsAfterJoin += 1;
      return membershipReadsAfterJoin > 1
        ? [
            membership({
              id: 9n,
              channelId: 5n,
              agentDbId: 1n,
              permission: { tag: 'ReadWrite' },
            }),
          ]
        : [];
    });

    const result = await joinPublicChannel({
      profileName: 'default',
      actorSlug: 'owner',
      slug: 'ops',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.joinPublicChannel).toHaveBeenCalledWith({
      agentDbId: 1n,
      channelId: 5n,
    });
    expect(result).toMatchObject({
      channelId: '5',
      permission: 'read_write',
      status: 'joined',
    });
  });

  it('passes channel settings updates through the generated reducer as an admin', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
      }),
    ]);
    mocks.iterVisibleChannelMemberships.mockReturnValue([
      membership({
        id: 9n,
        channelId: 5n,
        agentDbId: 1n,
        permission: { tag: 'Admin' },
      }),
    ]);

    await updateChannelSettings({
      profileName: 'default',
      actorSlug: 'owner',
      slug: 'ops',
      accessMode: 'approval_required',
      discoverable: false,
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.updateChannelSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 1n,
        channelId: 5n,
        accessMode: { tag: 'ApprovalRequired' },
        discoverable: false,
      })
    );
  });

  it('uses direct slug public history for authenticated reads outside visible channel state', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
      }),
    ]);

    const result = await readAuthenticatedChannelMessages({
      profileName: 'default',
      actorSlug: 'owner',
      slug: 'ops',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.listPublicChannelMessages).toHaveBeenCalledWith(
      expect.objectContaining({
      })
    );
    expect(result).toMatchObject({
      slug: 'ops',
      anonymous: false,
      cappedToRecent: false,
      messages: [],
    });
  });

  it('routes member permission updates through the renamed updateChannelMemberPermission reducer', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
      }),
    ]);
    mocks.iterVisibleChannelMemberships.mockReturnValue([
      membership({
        id: 9n,
        channelId: 5n,
        agentDbId: 1n,
        permission: { tag: 'Admin' },
      }),
    ]);

    await updateChannelMemberPermission({
      profileName: 'default',
      actorSlug: 'owner',
      slug: 'ops',
      memberAgentDbId: '42',
      permission: 'read_write',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.updateChannelMemberPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 1n,
        channelId: 5n,
        targetAgentDbId: 42n,
        permission: { tag: 'ReadWrite' },
      })
    );
  });

  it('reports channel not found locally before authenticated reads without visible or public rows', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([]);

    await expect(
      readAuthenticatedChannelMessages({
        profileName: 'default',
        actorSlug: 'owner',
        slug: 'hidden-ops',
        reporter: {
          info() {},
          success() {},
          verbose() {},
        },
      })
    ).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    expect(mocks.listChannelMessages).not.toHaveBeenCalled();
  });
});
