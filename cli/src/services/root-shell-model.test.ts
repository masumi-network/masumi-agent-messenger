import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { ShellRows } from './spacetimedb';
import { buildRootShellViewModel } from './root-shell-model';
import type {
  Agent,
  ThreadParticipant,
  Thread,
  ContactRequest,
  ContactAllowlistEntry,
  Device,
  DeviceShareRequest,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
} from '../../../webapp/src/module_bindings/types';

// Read-state merged into ThreadParticipant; alias kept so legacy fixture builders compile.
type VisibleThreadReadStateRow = ThreadParticipant;

function ts(iso: string) {
  return Timestamp.fromDate(new Date(iso));
}

function makeActor(overrides: Partial<Agent>): Agent {
  return {
    id: 0n,
    accountId: 0n,
    email: 'agent@example.com',
    slug: 'agent',
    isDefault: false,
    publicIdentity: 'agent-public',
    displayName: null,
    masumiAgentIdentifier: null,
    masumiInboxAgentId: null,
    publicDescription: null,
    publicLinkedEmailEnabled: false,
    ...overrides,
  } as Agent;
}

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: 0n,
    kind: { tag: 'Direct' as const },
    directLowAgentDbId: 1n,
    directHighAgentDbId: 2n,
    title: null,
    creatorAgentDbId: 0n,
    membershipVersion: 1n,
    lastMessageId: 0n,
    messageCount: 0n,
    activeParticipantCount: 0n,
    lastMessageAt: ts('2026-04-15T10:00:00.000Z'),
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as Thread;
}

function makeParticipant(
  overrides: Partial<ThreadParticipant>
): ThreadParticipant {
  return {
    id: 0n,
    threadId: 0n,
    agentDbId: 0n,
    active: true,
    lastSentSeq: 0n,
    ...overrides,
  } as ThreadParticipant;
}

function makeReadState(
  overrides: Partial<VisibleThreadReadStateRow>
): VisibleThreadReadStateRow {
  return {
    id: 0n,
    threadId: 0n,
    agentDbId: 0n,
    lastReadMessageId: 0n,
    archived: false,
    ...overrides,
  } as VisibleThreadReadStateRow;
}

function makeContactRequest(
  overrides: Partial<ContactRequest>
): ContactRequest {
  return {
    id: 0n,
    threadId: 0n,
    requesterAgentDbId: 0n,
    targetAgentDbId: 0n,
    status: { tag: 'Pending' as const },
    requesterResolvedSortKey: 0n,
    targetResolvedSortKey: 0n,
    targetSlug: 'target',
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as ContactRequest;
}

function makeAllowlistEntry(
  overrides: Partial<ContactAllowlistEntry>
): ContactAllowlistEntry {
  return {
    id: 0n,
    accountId: 0n,
    kind: { tag: 'Agent' as const },
    agentPublicIdentity: 'friend-public',
    agentSlug: 'friend',
    email: null,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as ContactAllowlistEntry;
}

function makeDevice(overrides: Partial<Device>): Device {
  return {
    id: 0n,
    accountId: 0n,
    deviceId: 'device-1',
    label: 'Laptop',
    platform: 'macos',
    status: { tag: 'Approved' as const },
    approvedAt: ts('2026-04-15T09:00:00.000Z'),
    revokedAt: null,
    lastSeenAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as Device;
}

function makeDeviceRequest(
  overrides: Partial<DeviceShareRequest>
): DeviceShareRequest {
  return {
    id: 0n,
    deviceId: 'device-1',
    label: 'Laptop',
    platform: 'macos',
    expiresAt: ts('2099-04-15T11:00:00.000Z'),
    createdAt: ts('2026-04-15T10:30:00.000Z'),
    approvedAt: null,
    consumedAt: null,
    pendingSortKey: 0n,
    ...overrides,
  } as DeviceShareRequest;
}

function makeChannel(overrides: Partial<Channel>): Channel {
  return {
    id: 0n,
    slug: 'ops',
    title: null,
    description: null,
    accessMode: { tag: 'Public' as const },
    discoverable: true,
    creatorAgentDbId: 0n,
    publicDiscoverableSortKey: 0n,
    defaultPermission: { tag: 'ReadWrite' as const },
    lastMessageId: 0n,
    messageCount: 0n,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    lastMessageAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as Channel;
}

function makeChannelMembership(
  overrides: Partial<ChannelMember>
): ChannelMember {
  return {
    id: 0n,
    channelId: 0n,
    agentDbId: 0n,
    permission: { tag: 'Read' as const },
    active: true,
    activeRecencySortKey: 0n,
    lastSentSeq: 0n,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as ChannelMember;
}

function makeChannelJoinRequest(
  overrides: Partial<ChannelJoinRequest>
): ChannelJoinRequest {
  return {
    id: 0n,
    channelId: 0n,
    requesterAgentDbId: 0n,
    permission: { tag: 'Read' as const },
    status: { tag: 'Pending' as const },
    channelResolvedSortKey: 0n,
    requesterResolvedSortKey: 0n,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    resolvedAt: null,
    ...overrides,
  } as ChannelJoinRequest;
}

function makeRows(overrides: Partial<ShellRows> = {}): ShellRows {
  return {
    inboxes: [],
    actors: [],
    participants: [],
    readStates: [],
    secretEnvelopes: [],
    threads: [],
    contactRequests: [],
    threadInvites: [],
    allowlistEntries: [],
    devices: [],
    deviceRequests: [],
    deviceBundles: [],
    threadSignals: [],
    channels: [],
    channelMemberships: [],
    channelJoinRequests: [],
    ...overrides,
  };
}

describe('buildRootShellViewModel', () => {
  it('selects the default owned inbox when no active slug is provided', () => {
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          publicIdentity: 'agent-public',
          isDefault: true,
        }),
        makeActor({
          id: 2n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'support',
          publicIdentity: 'support-public',
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      securityState: {
        status: 'healthy',
        title: 'Private keys are ready',
        description: 'Local keys match the published inbox keys.',
      },
      connectionHealth: 'live',
    });

    expect(model?.activeInbox.slug).toBe('agent');
    expect(model?.ownedInboxes.map(inbox => inbox.slug)).toEqual(['agent', 'support']);
    expect(model?.dashboard.attentionItems).toEqual([
      expect.objectContaining({
        id: 'agent:registration',
        targetTab: 'agents',
      }),
    ]);
  });

  it('treats backend registered masumi rows as managed agents', () => {
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          publicIdentity: 'agent-public',
          isDefault: true,
          masumiRegistrationNetwork: 'Preprod',
          masumiInboxAgentId: 'managed-agent-id',
          masumiAgentIdentifier: 'did:masumi:agent',
          masumiRegistrationState: { tag: 'Registered' },
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      securityState: {
        status: 'healthy',
        title: 'Private keys are ready',
        description: 'Local keys match the published inbox keys.',
      },
      connectionHealth: 'live',
    });

    expect(model?.agents.agentSummaries[0]).toMatchObject({
      slug: 'agent',
      managed: true,
      registered: true,
      deregistered: false,
    });
    expect(model?.dashboard.attentionItems.map(item => item.id)).not.toContain(
      'agent:registration'
    );
  });

  it('does not flag a normal initial connect as reconnecting', () => {
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          publicIdentity: 'agent-public',
          isDefault: true,
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      securityState: {
        status: 'healthy',
        title: 'Private keys are ready',
        description: 'Local keys match the published inbox keys.',
      },
      connectionHealth: 'connecting',
    });

    expect(model?.dashboard.attentionItems.map(item => item.id)).not.toContain(
      'connection:reconnecting'
    );
  });

  it('derives live dashboard state for the selected inbox slug', () => {
    const supportActor = makeActor({
      id: 2n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'support',
      publicIdentity: 'support-public',
      displayName: 'Support',
    });
    const externalActor = makeActor({
      id: 3n,
      accountId: 20n,
      email: 'friend@example.com',
      slug: 'friend',
      publicIdentity: 'friend-public',
      displayName: 'Friend',
    });
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          accountId: 10n,
          email: 'agent@example.com',
          slug: 'agent',
          publicIdentity: 'agent-public',
          isDefault: true,
        }),
        supportActor,
        externalActor,
      ],
      threads: [
        makeThread({
          id: 100n,
          kind: { tag: 'Direct' as const },
          lastMessageAt: ts('2026-04-15T10:05:00.000Z'),
          lastMessageId: 3n,
        }),
      ],
      participants: [
        makeParticipant({
          threadId: 100n,
          agentDbId: supportActor.id,
          lastSentSeq: 1n,
        }),
        makeParticipant({
          threadId: 100n,
          agentDbId: externalActor.id,
        }),
      ],
      readStates: [
        makeReadState({
          threadId: 100n,
          agentDbId: supportActor.id,
          lastReadMessageId: 2n,
        }),
      ],
      contactRequests: [
        makeContactRequest({
          id: 500n,
          threadId: 100n,
          requesterAgentDbId: externalActor.id,
          targetAgentDbId: supportActor.id,
          targetSlug: 'support',
        }),
        makeContactRequest({
          id: 501n,
          threadId: 101n,
          requesterAgentDbId: 1n,
          targetAgentDbId: externalActor.id,
          targetSlug: 'friend',
        }),
      ],
      allowlistEntries: [
        makeAllowlistEntry({
          id: 700n,
          accountId: 10n,
        }),
      ],
      devices: [
        makeDevice({
          id: 800n,
          accountId: 10n,
          deviceId: 'device-shell',
        }),
      ],
      deviceRequests: [
        makeDeviceRequest({
          id: 900n,
          deviceId: 'device-shell',
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      activeInboxSlug: 'support',
      securityState: {
        status: 'missing',
        title: 'Private keys are missing on this machine',
        description: 'Recover them from another device or import an encrypted backup.',
      },
      connectionHealth: 'reconnecting',
      pendingBackupPrompt: 'Create a backup after the latest local key change.',
    });

    expect(model?.activeInbox.slug).toBe('support');
    expect(model?.unreadCount).toBe(1);
    expect(model?.pendingRequestCount).toBe(1);
    expect(model?.inboxes.threads[0]).toMatchObject({
      id: '100',
      participants: ['friend', 'support'],
      unreadMessages: 1,
    });
    expect(model?.inboxes.requests.map(request => request.id)).toEqual(['500']);
    expect(model?.account.devices[0]).toMatchObject({
      deviceId: 'device-shell',
      pendingShareCount: 1,
    });
    expect(model?.dashboard.recentThreads.map(thread => thread.id)).toEqual(['100']);
    expect(model?.dashboard.recentRequests.map(request => request.id)).toEqual(['500']);
    expect(model?.inboxes.sections).toEqual([
      expect.objectContaining({
        key: 'threads',
        count: 1,
      }),
      expect.objectContaining({
        key: 'pending',
        count: 1,
      }),
      expect.objectContaining({
        key: 'archived',
        count: 0,
      }),
    ]);
    expect(model?.dashboard.attentionItems.map(item => item.id)).toEqual([
      'security:missing',
      'connection:reconnecting',
      'requests:pending',
      'agent:registration',
      'backup:recommended',
    ]);
    expect(model?.agents.agentSummaries[0]).toMatchObject({
      slug: 'agent',
      isDefault: true,
    });
    expect(model?.account.securityState).toMatchObject({
      status: 'missing',
    });
  });

  it('omits the pending-approval attention item when only outgoing requests are pending', () => {
    const supportActor = makeActor({
      id: 2n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'support',
      publicIdentity: 'support-public',
      isDefault: true,
    });
    const externalActor = makeActor({
      id: 3n,
      accountId: 20n,
      email: 'friend@example.com',
      slug: 'friend',
      publicIdentity: 'friend-public',
    });

    const rows = makeRows({
      actors: [supportActor, externalActor],
      contactRequests: [
        makeContactRequest({
          id: 500n,
          threadId: 100n,
          requesterAgentDbId: supportActor.id,
          targetAgentDbId: externalActor.id,
          targetSlug: 'friend',
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      activeInboxSlug: 'support',
      securityState: {
        status: 'healthy',
        title: '',
        description: '',
      },
      connectionHealth: 'live',
    });

    expect(model?.inboxes.requests.map(request => request.id)).toEqual(['500']);
    expect(
      model?.dashboard.attentionItems.some(item => item.id === 'requests:pending')
    ).toBe(false);
  });

  it('derives selectable channels and admin approval rows', () => {
    const defaultActor = makeActor({
      id: 1n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'agent',
      publicIdentity: 'agent-public',
      isDefault: true,
    });
    const supportActor = makeActor({
      id: 2n,
      accountId: 10n,
      email: 'agent@example.com',
      slug: 'support',
      publicIdentity: 'support-public',
    });
    const requester = makeActor({
      id: 3n,
      accountId: 20n,
      email: 'friend@example.com',
      slug: 'friend',
      publicIdentity: 'friend-public',
    });

    const rows = makeRows({
      actors: [defaultActor, supportActor, requester],
      channels: [
        makeChannel({
          id: 200n,
          slug: 'ops',
          title: 'Ops',
          accessMode: { tag: 'ApprovalRequired' as const },
          lastMessageAt: ts('2026-04-15T10:10:00.000Z'),
        }),
        makeChannel({
          id: 201n,
          slug: 'read-only',
          title: 'Read Only',
          lastMessageAt: ts('2026-04-15T10:20:00.000Z'),
        }),
        makeChannel({
          id: 202n,
          slug: 'writers',
          title: 'Writers',
          lastMessageAt: ts('2026-04-15T10:30:00.000Z'),
        }),
      ],
      channelMemberships: [
        makeChannelMembership({
          channelId: 200n,
          agentDbId: supportActor.id,
          permission: { tag: 'Admin' as const },
        }),
        makeChannelMembership({
          channelId: 201n,
          agentDbId: defaultActor.id,
          permission: { tag: 'Read' as const },
        }),
        makeChannelMembership({
          channelId: 202n,
          agentDbId: defaultActor.id,
          permission: { tag: 'ReadWrite' as const },
        }),
      ],
      channelJoinRequests: [
        makeChannelJoinRequest({
          id: 300n,
          channelId: 200n,
          requesterAgentDbId: requester.id,
          permission: { tag: 'ReadWrite' as const },
        }),
        makeChannelJoinRequest({
          id: 301n,
          channelId: 201n,
          requesterAgentDbId: requester.id,
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      activeInboxSlug: 'agent',
      securityState: {
        status: 'healthy',
        title: 'Private keys are ready',
        description: 'Local keys match the published inbox keys.',
      },
      connectionHealth: 'live',
    });

    expect(model?.channels.channels.map(channel => channel.slug)).toEqual([
      'writers',
      'read-only',
    ]);
    expect(model?.channels.channels.find(channel => channel.slug === 'read-only')).toMatchObject({
      slug: 'read-only',
      isAdmin: false,
      canSend: false,
      actorSlug: 'agent',
      pendingApprovals: 0,
    });
    expect(model?.channels.channels.find(channel => channel.slug === 'writers')).toMatchObject({
      slug: 'writers',
      isAdmin: false,
      canSend: true,
      actorSlug: 'agent',
      permission: 'read_write',
      pendingApprovals: 0,
    });
    expect(model?.channels.approvals).toEqual([]);
    expect(model?.channels.pendingApprovalCount).toBe(0);

    const supportModel = buildRootShellViewModel({
      rows,
      email: 'agent@example.com',
      activeInboxSlug: 'support',
      securityState: {
        status: 'healthy',
        title: 'Private keys are ready',
        description: 'Local keys match the published inbox keys.',
      },
      connectionHealth: 'live',
    });

    expect(supportModel?.channels.channels.map(channel => channel.slug)).toEqual(['ops']);
    expect(supportModel?.channels.channels[0]).toMatchObject({
      slug: 'ops',
      isAdmin: true,
      canSend: true,
      actorSlug: 'support',
      pendingApprovals: 1,
    });
    expect(supportModel?.channels.approvals).toEqual([
      expect.objectContaining({
        id: '300',
        permission: 'read_write',
        adminAgentSlug: 'support',
      }),
    ]);
    expect(supportModel?.channels.pendingApprovalCount).toBe(1);
    expect(supportModel?.dashboard.attentionItems.map(item => item.id)).toContain(
      'channels:pending'
    );
  });
});
