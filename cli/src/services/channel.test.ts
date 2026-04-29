import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type {
  Agent,
  PublicChannelMirrorRow,
  VisibleChannelMembershipRow,
  VisibleChannelRow,
} from '../../../webapp/src/module_bindings/types';

const mocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
  updateChannelSettings: vi.fn(),
  joinPublicChannel: vi.fn(),
  listChannelMessages: vi.fn(),
  listPublicChannelMessages: vi.fn(),
  readOwnedAgent: vi.fn(),
  readPublicChannel: vi.fn(),
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
}));

import {
  createChannel,
  joinPublicChannel,
  readAuthenticatedChannelMessages,
  updateChannelSettings,
} from './channel';

function timestamp(microsSinceUnixEpoch: bigint) {
  return new Timestamp(microsSinceUnixEpoch);
}

function actor(row: Partial<Agent> & Pick<Agent, 'id' | 'inboxId' | 'slug'>): Agent {
  return {
    id: row.id,
    inboxId: row.inboxId,
    normalizedEmail: row.normalizedEmail ?? 'owner@example.com',
    slug: row.slug,
    inboxIdentifier: row.inboxIdentifier,
    isDefault: row.isDefault ?? true,
    publicIdentity: row.publicIdentity ?? row.slug,
    displayName: row.displayName,
    currentEncryptionPublicKey: row.currentEncryptionPublicKey ?? 'enc',
    currentEncryptionKeyVersion: row.currentEncryptionKeyVersion ?? 'enc-v1',
    currentSigningPublicKey: row.currentSigningPublicKey ?? 'sig',
    currentSigningKeyVersion: row.currentSigningKeyVersion ?? 'sig-v1',
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    publicDescription: row.publicDescription,
    publicLinkedEmailEnabled: row.publicLinkedEmailEnabled ?? false,
    allowAllMessageContentTypes: row.allowAllMessageContentTypes ?? false,
    allowAllMessageHeaders: row.allowAllMessageHeaders ?? false,
    supportedMessageContentTypes: row.supportedMessageContentTypes,
    supportedMessageHeaderNames: row.supportedMessageHeaderNames,
    currentEncryptionAlgorithm: row.currentEncryptionAlgorithm ?? 'ecdh-p256-v1',
    currentSigningAlgorithm: row.currentSigningAlgorithm ?? 'ecdsa-p256-sha256-v1',
    masumiRegistrationNetwork: row.masumiRegistrationNetwork,
    masumiInboxAgentId: row.masumiInboxAgentId,
    masumiAgentIdentifier: row.masumiAgentIdentifier,
    masumiRegistrationState: row.masumiRegistrationState,
  } as Agent;
}

function channel(row: Partial<VisibleChannelRow> & Pick<VisibleChannelRow, 'id' | 'slug'>): VisibleChannelRow {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    accessMode: row.accessMode ?? 'public',
    publicJoinPermission: row.publicJoinPermission ?? 'read',
    discoverable: row.discoverable ?? true,
    creatorAgentDbId: row.creatorAgentDbId ?? 1n,
    lastMessageSeq: row.lastMessageSeq ?? 0n,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    lastMessageAt: row.lastMessageAt ?? timestamp(1n),
  };
}

function publicChannel(
  row: Partial<PublicChannelMirrorRow> & Pick<PublicChannelMirrorRow, 'channelId' | 'slug'>
): PublicChannelMirrorRow {
  return {
    id: row.id ?? row.channelId,
    channelId: row.channelId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    accessMode: row.accessMode ?? 'public',
    discoverable: row.discoverable ?? true,
    lastMessageSeq: row.lastMessageSeq ?? 0n,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    lastMessageAt: row.lastMessageAt ?? timestamp(1n),
    publicJoinPermission: row.publicJoinPermission ?? 'read',
    sortKey: row.sortKey ?? 'sort',
  };
}

function membership(
  row: Partial<VisibleChannelMembershipRow> &
    Pick<VisibleChannelMembershipRow, 'id' | 'channelId' | 'agentDbId'>
): VisibleChannelMembershipRow {
  return {
    id: row.id,
    channelId: row.channelId,
    agentDbId: row.agentDbId,
    permission: row.permission ?? 'read',
    active: row.active ?? true,
    lastSentSeq: row.lastSentSeq ?? 0n,
    joinedAt: row.joinedAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
  };
}

function makeConnection() {
  return {
    reducers: {
      createChannel: mocks.createChannel,
      updateChannelSettings: mocks.updateChannelSettings,
      joinPublicChannel: mocks.joinPublicChannel,
    },
    procedures: {
      listChannelMessages: mocks.listChannelMessages,
      listPublicChannelMessages: mocks.listPublicChannelMessages,
      readOwnedAgent: mocks.readOwnedAgent,
      readPublicChannel: mocks.readPublicChannel,
      readVisibleChannelState: mocks.readVisibleChannelState,
    },
    db: {
      visibleAgents: {
        iter: mocks.iterVisibleAgents,
      },
      visibleChannels: {
        iter: mocks.iterVisibleChannels,
      },
      visibleChannelMemberships: {
        iter: mocks.iterVisibleChannelMemberships,
      },
      visibleChannelJoinRequests: {
        iter: () => [],
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
    mocks.joinPublicChannel.mockReset();
    mocks.listChannelMessages.mockReset();
    mocks.listPublicChannelMessages.mockReset();
    mocks.readOwnedAgent.mockReset();
    mocks.readPublicChannel.mockReset();
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
    mocks.readOwnedAgent.mockImplementation(async ({ agentSlug }: { agentSlug?: string }) =>
      (Array.from(mocks.iterVisibleAgents()) as Agent[]).filter(actor =>
        agentSlug === undefined ? actor.isDefault : actor.slug === agentSlug
      )
    );
    mocks.readPublicChannel.mockImplementation(async ({ channelSlug }: { channelSlug?: string }) =>
      (Array.from(mocks.iterPublicChannels()) as PublicChannelMirrorRow[]).filter(
        row => channelSlug === undefined || row.slug === channelSlug
      )
    );
    mocks.readVisibleChannelState.mockImplementation(
      async ({ channelSlug }: { channelSlug?: string }) => {
        const channels = (Array.from(mocks.iterVisibleChannels()) as VisibleChannelRow[]).filter(
          row => channelSlug === undefined || row.slug === channelSlug
        );
        return {
          actors: Array.from(mocks.iterVisibleAgents()) as Agent[],
          channels,
          memberships: Array.from(
            mocks.iterVisibleChannelMemberships()
          ) as VisibleChannelMembershipRow[],
          requests: [],
        };
      }
    );
  });

  it('refuses channel mutations from a default agent with pending deregistration', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
        masumiRegistrationState: 'DeregistrationRequested',
      }),
    ]);

    await expect(
      createChannel({
        profileName: 'default',
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

  it('passes public auto-join permission when creating a channel', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
      }),
    ]);

    await createChannel({
      profileName: 'default',
      slug: 'ops',
      accessMode: 'public',
      publicJoinPermission: 'read_write',
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
        accessMode: 'public',
        publicJoinPermission: 'read_write',
      })
    );
  });

  it('waits for the joined membership before reporting join permission', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([
      channel({
        id: 5n,
        slug: 'ops',
        publicJoinPermission: 'read',
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
              permission: 'read_write',
            }),
          ]
        : [];
    });

    const result = await joinPublicChannel({
      profileName: 'default',
      slug: 'ops',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.joinPublicChannel).toHaveBeenCalledWith({
      agentDbId: 1n,
      channelId: undefined,
      channelSlug: 'ops',
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
        inboxId: 10n,
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
        permission: 'admin',
      }),
    ]);

    await updateChannelSettings({
      profileName: 'default',
      slug: 'ops',
      accessMode: 'approval_required',
      publicJoinPermission: 'read_write',
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
        channelSlug: undefined,
        accessMode: 'approval_required',
        publicJoinPermission: 'read_write',
        discoverable: false,
      })
    );
  });

  it('uses the public channel mirror for authenticated reads outside visible channel state', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([
      publicChannel({
        id: 8n,
        channelId: 5n,
        slug: 'ops',
        publicJoinPermission: 'read_write',
      }),
    ]);

    const result = await readAuthenticatedChannelMessages({
      profileName: 'default',
      slug: 'ops',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.listChannelMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 1n,
        channelId: 5n,
        channelSlug: undefined,
      })
    );
    expect(result).toMatchObject({
      slug: 'ops',
      anonymous: false,
      cappedToRecent: false,
      messages: [],
    });
  });

  it('reports channel not found locally before authenticated reads without visible or public rows', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        inboxId: 10n,
        slug: 'owner',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([]);

    await expect(
      readAuthenticatedChannelMessages({
        profileName: 'default',
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
