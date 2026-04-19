import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import type { ShellRows } from './spacetimedb';
import { buildRootShellViewModel } from './root-shell-model';
import type {
  VisibleAgentRow,
  VisibleThreadParticipantRow,
  VisibleThreadReadStateRow,
  VisibleThreadRow,
  VisibleContactRequestRow,
  VisibleContactAllowlistEntryRow,
  VisibleDeviceRow,
  VisibleDeviceShareRequestRow,
  VisibleMessageRow,
} from '../../../webapp/src/module_bindings/types';

function ts(iso: string) {
  return Timestamp.fromDate(new Date(iso));
}

function makeActor(overrides: Partial<VisibleAgentRow>): VisibleAgentRow {
  return {
    id: 0n,
    inboxId: 0n,
    normalizedEmail: 'agent@example.com',
    slug: 'agent',
    isDefault: false,
    publicIdentity: 'agent-public',
    displayName: null,
    masumiAgentIdentifier: null,
    masumiInboxAgentId: null,
    publicDescription: null,
    publicLinkedEmailEnabled: false,
    ...overrides,
  } as VisibleAgentRow;
}

function makeThread(overrides: Partial<VisibleThreadRow>): VisibleThreadRow {
  return {
    id: 0n,
    dedupeKey: 'direct:agent:other',
    kind: 'direct',
    membershipLocked: false,
    title: null,
    creatorAgentDbId: 0n,
    membershipVersion: 1n,
    nextThreadSeq: 0n,
    lastMessageAt: ts('2026-04-15T10:00:00.000Z'),
    lastMessageSeq: 0n,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as VisibleThreadRow;
}

function makeParticipant(
  overrides: Partial<VisibleThreadParticipantRow>
): VisibleThreadParticipantRow {
  return {
    id: 0n,
    threadId: 0n,
    agentDbId: 0n,
    active: true,
    lastSentSeq: 0n,
    ...overrides,
  } as VisibleThreadParticipantRow;
}

function makeReadState(
  overrides: Partial<VisibleThreadReadStateRow>
): VisibleThreadReadStateRow {
  return {
    id: 0n,
    threadId: 0n,
    agentDbId: 0n,
    lastReadThreadSeq: 0n,
    archived: false,
    ...overrides,
  } as VisibleThreadReadStateRow;
}

function makeMessage(overrides: Partial<VisibleMessageRow>): VisibleMessageRow {
  return {
    id: 0n,
    threadId: 0n,
    threadSeq: 0n,
    senderAgentDbId: 0n,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as VisibleMessageRow;
}

function makeContactRequest(
  overrides: Partial<VisibleContactRequestRow>
): VisibleContactRequestRow {
  return {
    id: 0n,
    threadId: 0n,
    requesterAgentDbId: 0n,
    targetAgentDbId: 0n,
    direction: 'incoming',
    status: 'pending',
    messageCount: 0n,
    requesterSlug: 'requester',
    requesterDisplayName: null,
    targetSlug: 'target',
    targetDisplayName: null,
    updatedAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as VisibleContactRequestRow;
}

function makeAllowlistEntry(
  overrides: Partial<VisibleContactAllowlistEntryRow>
): VisibleContactAllowlistEntryRow {
  return {
    id: 0n,
    inboxId: 0n,
    kind: 'agent',
    agentPublicIdentity: 'friend-public',
    agentDisplayName: 'Friend',
    agentSlug: 'friend',
    displayEmail: null,
    normalizedEmail: null,
    createdAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as VisibleContactAllowlistEntryRow;
}

function makeDevice(overrides: Partial<VisibleDeviceRow>): VisibleDeviceRow {
  return {
    id: 0n,
    inboxId: 0n,
    deviceId: 'device-1',
    label: 'Laptop',
    platform: 'macos',
    status: 'approved',
    approvedAt: ts('2026-04-15T09:00:00.000Z'),
    revokedAt: null,
    lastSeenAt: ts('2026-04-15T10:00:00.000Z'),
    ...overrides,
  } as VisibleDeviceRow;
}

function makeDeviceRequest(
  overrides: Partial<VisibleDeviceShareRequestRow>
): VisibleDeviceShareRequestRow {
  return {
    id: 0n,
    deviceId: 'device-1',
    label: 'Laptop',
    platform: 'macos',
    expiresAt: ts('2099-04-15T11:00:00.000Z'),
    createdAt: ts('2026-04-15T10:30:00.000Z'),
    approvedAt: null,
    consumedAt: null,
    ...overrides,
  } as VisibleDeviceShareRequestRow;
}

function makeRows(overrides: Partial<ShellRows> = {}): ShellRows {
  return {
    inboxes: [],
    actors: [],
    bundles: [],
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
    messages: [],
    ...overrides,
  };
}

describe('buildRootShellViewModel', () => {
  it('selects the default owned inbox when no active slug is provided', () => {
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'agent@example.com',
          slug: 'agent',
          publicIdentity: 'agent-public',
          isDefault: true,
        }),
        makeActor({
          id: 2n,
          inboxId: 10n,
          normalizedEmail: 'agent@example.com',
          slug: 'support',
          publicIdentity: 'support-public',
        }),
      ],
    });

    const model = buildRootShellViewModel({
      rows,
      normalizedEmail: 'agent@example.com',
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

  it('derives live dashboard state for the selected inbox slug', () => {
    const supportActor = makeActor({
      id: 2n,
      inboxId: 10n,
      normalizedEmail: 'agent@example.com',
      slug: 'support',
      publicIdentity: 'support-public',
      displayName: 'Support',
    });
    const externalActor = makeActor({
      id: 3n,
      inboxId: 20n,
      normalizedEmail: 'friend@example.com',
      slug: 'friend',
      publicIdentity: 'friend-public',
      displayName: 'Friend',
    });
    const rows = makeRows({
      actors: [
        makeActor({
          id: 1n,
          inboxId: 10n,
          normalizedEmail: 'agent@example.com',
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
          kind: 'direct',
          lastMessageAt: ts('2026-04-15T10:05:00.000Z'),
          lastMessageSeq: 2n,
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
          lastReadThreadSeq: 1n,
        }),
      ],
      messages: [
        makeMessage({
          id: 1000n,
          threadId: 100n,
          threadSeq: 1n,
          senderAgentDbId: supportActor.id,
          createdAt: ts('2026-04-15T10:00:00.000Z'),
        }),
        makeMessage({
          id: 1001n,
          threadId: 100n,
          threadSeq: 2n,
          senderAgentDbId: externalActor.id,
          createdAt: ts('2026-04-15T10:05:00.000Z'),
        }),
      ],
      contactRequests: [
        makeContactRequest({
          id: 500n,
          threadId: 100n,
          requesterAgentDbId: supportActor.id,
          targetAgentDbId: externalActor.id,
          direction: 'outgoing',
          requesterSlug: 'support',
          targetSlug: 'friend',
        }),
        makeContactRequest({
          id: 501n,
          threadId: 101n,
          requesterAgentDbId: 1n,
          targetAgentDbId: externalActor.id,
          direction: 'outgoing',
          requesterSlug: 'agent',
          targetSlug: 'friend',
        }),
      ],
      allowlistEntries: [
        makeAllowlistEntry({
          id: 700n,
          inboxId: 10n,
        }),
      ],
      devices: [
        makeDevice({
          id: 800n,
          inboxId: 10n,
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
      normalizedEmail: 'agent@example.com',
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
});
