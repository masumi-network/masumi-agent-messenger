import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type {
  Agent,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
} from '../../../webapp/src/module_bindings/types';
import type { AgentKeyPair } from '../../../shared/agent-crypto';

const mocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
  updateChannelSettings: vi.fn(),
  updateChannelMemberPermission: vi.fn(),
  joinPublicChannel: vi.fn(),
  sendChannelMessage: vi.fn(),
  listChannelMessages: vi.fn(),
  listPublicChannelMessages: vi.fn(),
  readOwnedAgent: vi.fn(),
  lookupAgentPublicKeys: vi.fn(),
  lookupPublicChannelBySlug: vi.fn(),
  readVisibleChannelState: vi.fn(),
  prepareChannelMessage: vi.fn(),
  verifySignedChannelMessage: vi.fn(),
  getStoredActorKeyPair: vi.fn(),
  requireImportedRotationKeyConfirmed: vi.fn(),
  disconnectConnection: vi.fn(),
  ensureAuthenticatedSession: vi.fn(),
  iterVisibleAgents: vi.fn(),
  iterChannelJoinRequests: vi.fn(),
  iterPublicChannels: vi.fn(),
  iterVisibleChannels: vi.fn(),
  iterVisibleChannelMemberships: vi.fn(),
  unsubscribe: vi.fn(),
  connectAuthenticated: vi.fn(),
}));

vi.mock('./auth', () => ({
  ensureAuthenticatedSession: mocks.ensureAuthenticatedSession,
}));

vi.mock('../../../shared/channel-crypto', () => ({
  prepareChannelMessage: mocks.prepareChannelMessage,
  verifySignedChannelMessage: mocks.verifySignedChannelMessage,
}));

vi.mock('./actor-keys', () => ({
  getStoredActorKeyPair: mocks.getStoredActorKeyPair,
}));

vi.mock('./imported-rotation-key-confirmation', () => ({
  requireImportedRotationKeyConfirmed: mocks.requireImportedRotationKeyConfirmed,
}));

vi.mock('./spacetimedb', () => ({
  connectAuthenticated: mocks.connectAuthenticated,
  disconnectConnection: mocks.disconnectConnection,
  readAllOwnedAgents: async () => Array.from(mocks.iterVisibleAgents()) as Agent[],
  readPendingChannelJoinRequests: async () =>
    Array.from(mocks.iterChannelJoinRequests()) as ChannelJoinRequest[],
}));

import {
  createChannel,
  joinPublicChannel,
  listChannelJoinRequests,
  readAuthenticatedChannelMessages,
  sendChannelMessage,
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

function joinRequest(
  row: Partial<ChannelJoinRequest> &
    Pick<ChannelJoinRequest, 'id' | 'channelId' | 'requesterAgentDbId'>
): ChannelJoinRequest {
  return {
    id: row.id,
    channelId: row.channelId,
    requesterAgentDbId: row.requesterAgentDbId,
    requesterAccountId: row.requesterAccountId ?? 99n,
    permission: row.permission ?? { tag: 'ReadWrite' },
    status: row.status ?? { tag: 'Pending' },
    channelResolvedSortKey: row.channelResolvedSortKey ?? 0n,
    requesterResolvedSortKey: row.requesterResolvedSortKey ?? 0n,
    channelPendingSortKey: row.channelPendingSortKey ?? 0n,
    requesterPendingSortKey: row.requesterPendingSortKey ?? 0n,
    createdAt: row.createdAt ?? timestamp(1n),
    updatedAt: row.updatedAt ?? timestamp(1n),
    resolvedAt: row.resolvedAt,
    resolvedByAgentDbId: row.resolvedByAgentDbId,
  };
}

function keyPair(version = 1): AgentKeyPair {
  return {
    encryption: {
      publicKey: 'encryption-public-key',
      privateKey: 'encryption-private-key',
      keyVersion: version,
      algorithm: 'ecdh-p256-v1',
    },
    signing: {
      publicKey: 'signing-public-key',
      privateKey: 'signing-private-key',
      keyVersion: version,
      algorithm: 'ecdsa-p256-sha256-v1',
    },
  };
}

function makeConnection() {
  return {
    reducers: {
      createChannel: mocks.createChannel,
      updateChannelSettings: mocks.updateChannelSettings,
      updateChannelMemberPermission: mocks.updateChannelMemberPermission,
      joinPublicChannel: mocks.joinPublicChannel,
      sendChannelMessage: mocks.sendChannelMessage,
    },
    procedures: {
      listChannelMessages: mocks.listChannelMessages,
      listPublicChannelMessages: mocks.listPublicChannelMessages,
      readOwnedAgent: mocks.readOwnedAgent,
      lookupAgentPublicKeys: mocks.lookupAgentPublicKeys,
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
    mocks.sendChannelMessage.mockReset();
    mocks.listChannelMessages.mockReset();
    mocks.listPublicChannelMessages.mockReset();
    mocks.readOwnedAgent.mockReset();
    mocks.lookupAgentPublicKeys.mockReset();
    mocks.lookupPublicChannelBySlug.mockReset();
    mocks.readVisibleChannelState.mockReset();
    mocks.prepareChannelMessage.mockReset();
    mocks.verifySignedChannelMessage.mockReset();
    mocks.getStoredActorKeyPair.mockReset();
    mocks.requireImportedRotationKeyConfirmed.mockReset();
    mocks.disconnectConnection.mockReset();
    mocks.ensureAuthenticatedSession.mockReset();
    mocks.iterVisibleAgents.mockReset();
    mocks.iterChannelJoinRequests.mockReset();
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
    mocks.iterChannelJoinRequests.mockReturnValue([]);
    mocks.iterVisibleChannels.mockReturnValue([]);
    mocks.iterPublicChannels.mockReturnValue([]);
    mocks.iterVisibleChannelMemberships.mockReturnValue([]);
    mocks.sendChannelMessage.mockResolvedValue(undefined);
    mocks.listChannelMessages.mockResolvedValue([]);
    mocks.listPublicChannelMessages.mockResolvedValue([]);
    const storedKeyPair = keyPair();
    mocks.getStoredActorKeyPair.mockResolvedValue(storedKeyPair);
    mocks.lookupAgentPublicKeys.mockResolvedValue([
      {
        agentDbId: 1n,
        keyKind: { tag: 'Encryption' },
        keyVersion: 1,
        publicKey: storedKeyPair.encryption.publicKey,
      },
      {
        agentDbId: 1n,
        keyKind: { tag: 'Signing' },
        keyVersion: 1,
        publicKey: storedKeyPair.signing.publicKey,
      },
    ]);
    mocks.prepareChannelMessage.mockResolvedValue({
      senderSigningKeyVersion: 1,
      plaintext: '{"contentType":"text/plain","body":"hello"}',
      signature: '00'.repeat(64),
    });
    mocks.requireImportedRotationKeyConfirmed.mockResolvedValue(undefined);
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

  it('sends as the selected agent even when visible channel state returns another account member', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
      actor({
        id: 2n,
        accountId: 10n,
        slug: 'patrick-nmkr-io',
        publicIdentity: 'patrick-nmkr-io',
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
        permission: { tag: 'Read' },
      }),
    ]);

    await sendChannelMessage({
      profileName: 'default',
      actorSlug: 'patrick-nmkr-io',
      slug: 'ops',
      message: 'hello',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(mocks.prepareChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 5n,
        senderPublicIdentity: 'patrick-nmkr-io',
      })
    );
    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDbId: 2n,
        channelId: 5n,
      })
    );
  });

  it('scopes channel join requests to the selected active agent context', async () => {
    mocks.iterVisibleAgents.mockReturnValue([
      actor({
        id: 1n,
        accountId: 10n,
        slug: 'owner',
      }),
      actor({
        id: 2n,
        accountId: 10n,
        slug: 'patrick-nmkr-io',
      }),
    ]);
    mocks.iterVisibleChannels.mockReturnValue([
      channel({ id: 5n, slug: 'patrick-admin' }),
      channel({ id: 6n, slug: 'owner-admin' }),
      channel({ id: 7n, slug: 'requested-by-patrick' }),
    ]);
    mocks.iterVisibleChannelMemberships.mockReturnValue([
      membership({
        id: 10n,
        channelId: 5n,
        agentDbId: 2n,
        permission: { tag: 'Admin' },
      }),
      membership({
        id: 11n,
        channelId: 6n,
        agentDbId: 1n,
        permission: { tag: 'Admin' },
      }),
    ]);
    mocks.iterChannelJoinRequests.mockReturnValue([
      joinRequest({
        id: 20n,
        channelId: 5n,
        requesterAgentDbId: 99n,
      }),
      joinRequest({
        id: 21n,
        channelId: 6n,
        requesterAgentDbId: 99n,
      }),
      joinRequest({
        id: 22n,
        channelId: 7n,
        requesterAgentDbId: 2n,
      }),
    ]);

    const result = await listChannelJoinRequests({
      profileName: 'default',
      actorSlug: 'patrick-nmkr-io',
      reporter: {
        info() {},
        success() {},
        verbose() {},
      },
    });

    expect(result.requests.map(request => request.id)).toEqual(['20', '22']);
    expect(result.requests.map(request => request.direction)).toEqual(['incoming', 'outgoing']);
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
