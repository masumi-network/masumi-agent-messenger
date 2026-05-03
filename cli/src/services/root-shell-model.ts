import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  isDeregisteringOrDeregisteredMasumiRegistrationMetadata,
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import { isTimestampInFuture, timestampToISOString } from '../../../shared/spacetime-time';
import type {
  Agent,
  ThreadParticipantPreview,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
} from '../../../webapp/src/module_bindings/types';
import type { ShellRows, VisibleThreadReadStateRow } from './spacetimedb';

export type OwnedInboxSummary = {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  isDefault: boolean;
  managed: boolean;
  registered: boolean;
  deregistered: boolean;
  publicDescription: string | null;
  publicLinkedEmailEnabled: boolean;
};

export type ShellThreadSummary = {
  id: string;
  kind: string;
  label: string;
  unreadMessages: number;
  archived: boolean;
  locked: boolean;
  participantCount: number;
  participants: string[];
  lastMessageAt: string;
  lastMessageId: string;
};

export type ShellRequestSummary = {
  id: string;
  threadId: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'approved' | 'rejected';
  messageCount: string;
  requesterSlug: string;
  requesterDisplayName: string | null;
  targetSlug: string;
  targetDisplayName: string | null;
  updatedAt: string;
};

export type ShellAllowlistSummary = {
  id: string;
  kind: 'agent' | 'email';
  value: string;
  label: string | null;
  createdAt: string;
};

export type ShellDeviceSummary = {
  deviceId: string;
  label: string | null;
  platform: string | null;
  status: string;
  approvedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string;
  pendingShareCount: number;
};

export type ShellDeviceRequestSummary = {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string | null;
  expiresAt: string;
  createdAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
};

export type ShellSecurityState = {
  status: 'healthy' | 'missing' | 'mismatch';
  title: string;
  description: string;
};

export type ShellChannelSummary = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  accessMode: string;
  discoverable: boolean;
  messageCount: string;
  lastMessageAt: string;
  permission: string;
  canSend: boolean;
  isAdmin: boolean;
  actorSlug: string;
  pendingApprovals: number;
};

export type ShellChannelApprovalSummary = {
  id: string;
  channelId: string;
  channelSlug: string;
  channelTitle: string | null;
  requesterAgentDbId: string;
  requesterSlug: string;
  requesterDisplayName: string | null;
  permission: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
  adminAgentSlug: string;
};

export type DashboardAttentionItem = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  targetTab: 'dashboard' | 'inboxes' | 'channels' | 'agents' | 'account';
  targetSection?: string;
};

export type RootShellConnectionHealth =
  | 'live'
  | 'reconnecting'
  | 'connecting'
  | 'error'
  | 'signed_out';

export type InboxSectionKey = 'threads' | 'pending' | 'archived';

export type InboxSectionItem = {
  id: string;
  kind: 'thread' | 'request';
  label: string;
  subtitle: string;
  unreadMessages: number;
  threadId?: string;
  requestId?: string;
  archived?: boolean;
  direction?: 'incoming' | 'outgoing';
};

export type InboxSection = {
  key: InboxSectionKey;
  label: string;
  count: number;
  items: InboxSectionItem[];
};

export type RootShellViewModel = {
  activeInbox: OwnedInboxSummary;
  ownedInboxes: OwnedInboxSummary[];
  unreadCount: number;
  pendingRequestCount: number;
  dashboard: {
    attentionItems: DashboardAttentionItem[];
    recentThreads: ShellThreadSummary[];
    recentRequests: ShellRequestSummary[];
  };
  inboxes: {
    sections: InboxSection[];
    threads: ShellThreadSummary[];
    requests: ShellRequestSummary[];
    allowlist: ShellAllowlistSummary[];
  };
  channels: {
    channels: ShellChannelSummary[];
    approvals: ShellChannelApprovalSummary[];
    pendingApprovalCount: number;
  };
  agents: {
    agentSummaries: OwnedInboxSummary[];
  };
  account: {
    securityState: ShellSecurityState;
    devices: ShellDeviceSummary[];
    deviceRequests: ShellDeviceRequestSummary[];
  };
};

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function enumTag(value: { tag: string } | string | null | undefined): string {
  if (typeof value === 'string') return value;
  return value?.tag ?? '';
}

function contactRequestStatusToCli(status: { tag: string } | string | null | undefined): ShellRequestSummary['status'] {
  const tag = enumTag(status);
  if (tag === 'Approved' || tag === 'approved') return 'approved';
  if (tag === 'Rejected' || tag === 'rejected') return 'rejected';
  return 'pending';
}

function allowlistKindToCli(kind: { tag: string } | string | null | undefined): ShellAllowlistSummary['kind'] {
  const tag = enumTag(kind);
  return tag === 'Agent' || tag === 'agent' ? 'agent' : 'email';
}

function channelPermissionToCli(permission: { tag: string } | string | null | undefined): string {
  const tag = enumTag(permission);
  if (tag === 'ReadWrite') return 'read_write';
  if (tag === 'Admin') return 'admin';
  if (tag === 'Read') return 'read';
  return tag || 'none';
}

function channelAccessModeToCli(accessMode: { tag: string } | string | null | undefined): string {
  const tag = enumTag(accessMode);
  return tag === 'ApprovalRequired' || tag === 'approval_required'
    ? 'approval_required'
    : 'public';
}

function sortOwnedActors(left: Agent, right: Agent): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }

  return left.slug.localeCompare(right.slug);
}

function buildReadStateByThreadId(
  readStates: VisibleThreadReadStateRow[],
  actorId: bigint
): Map<bigint, VisibleThreadReadStateRow> {
  return new Map(
    readStates
      .filter(readState => readState.agentDbId === actorId)
      .map(readState => [readState.threadId, readState] as const)
  );
}

function toOwnedInboxSummary(actor: Agent): OwnedInboxSummary {
  const metadata = readActorRegistrationMetadata(actor);
  const registration = registrationResultFromMetadata(metadata);
  return {
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    managed: metadata !== null,
    registered: registration.status === 'registered',
    deregistered: isDeregisteredOwnedActor(actor),
    publicDescription: actor.publicDescription ?? null,
    publicLinkedEmailEnabled: actor.publicLinkedEmailEnabled,
  };
}

function isDeregisteredOwnedActor(actor: Agent): boolean {
  return isDeregisteringOrDeregisteredMasumiRegistrationMetadata(
    readActorRegistrationMetadata(actor)
  );
}

function readActorRegistrationMetadata(
  actor: Agent
): MasumiActorRegistrationMetadata | null {
  const masumiRegistrationState = enumTag(actor.masumiRegistrationState);
  const granularRegistrationState = (() => {
    if (masumiRegistrationState && isMasumiInboxAgentState(masumiRegistrationState)) {
      return masumiRegistrationState;
    }
    switch (masumiRegistrationState) {
      case 'PendingRegistration':
        return 'RegistrationRequested';
      case 'Registered':
        return 'RegistrationConfirmed';
      case 'PendingDeregistration':
        return 'DeregistrationRequested';
      case 'Deregistered':
        return 'DeregistrationConfirmed';
      case 'Failed':
        return 'RegistrationFailed';
      default:
        return undefined;
    }
  })();
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState: granularRegistrationState,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

function listThreadParticipants(params: {
  threadId: bigint;
  participantsByThreadId: Map<bigint, ThreadParticipantPreview[]>;
  actorsById: Map<bigint, Agent>;
}): string[] {
  return (params.participantsByThreadId.get(params.threadId) ?? [])
    .map(participant => params.actorsById.get(participant.agentDbId)?.slug ?? null)
    .filter((slug): slug is string => Boolean(slug))
    .sort((left, right) => left.localeCompare(right));
}

function buildInboxSections(params: {
  threads: ShellThreadSummary[];
  requests: ShellRequestSummary[];
}): InboxSection[] {
  const activeThreads = params.threads
    .filter(thread => !thread.archived)
    .map(thread => ({
      id: `thread:${thread.id}`,
      kind: 'thread',
      label: thread.label,
      subtitle: `${thread.unreadMessages > 0 ? `${thread.unreadMessages} unread` : 'No unread'} · ${thread.lastMessageAt}`,
      unreadMessages: thread.unreadMessages,
      threadId: thread.id,
      archived: false,
    }) satisfies InboxSectionItem);
  const pendingRequests = params.requests.map(request => ({
    id: `request:${request.id}`,
    kind: 'request',
    label:
      request.direction === 'incoming'
        ? `${request.requesterDisplayName ?? request.requesterSlug} wants to connect`
        : `Waiting on ${request.targetDisplayName ?? request.targetSlug}`,
    subtitle: `${request.messageCount} msg · ${request.updatedAt}`,
    unreadMessages: 0,
    requestId: request.id,
    threadId: request.threadId,
    direction: request.direction,
  }) satisfies InboxSectionItem);
  const archivedThreads = params.threads
    .filter(thread => thread.archived)
    .map(thread => ({
      id: `thread:${thread.id}`,
      kind: 'thread',
      label: thread.label,
      subtitle: `Archived · ${thread.lastMessageAt}`,
      unreadMessages: thread.unreadMessages,
      threadId: thread.id,
      archived: true,
    }) satisfies InboxSectionItem);

  return [
    {
      key: 'threads',
      label: 'Threads',
      count: activeThreads.length,
      items: activeThreads,
    },
    {
      key: 'pending',
      label: 'Pending requests',
      count: pendingRequests.length,
      items: pendingRequests,
    },
    {
      key: 'archived',
      label: 'Archived',
      count: archivedThreads.length,
      items: archivedThreads,
    },
  ];
}

function buildChannelState(params: {
  channels: Channel[];
  memberships: ChannelMember[];
  requests: ChannelJoinRequest[];
  activeActor: Agent;
}): RootShellViewModel['channels'] {
  const membershipByChannelId = new Map<bigint, ChannelMember>();

  for (const membership of params.memberships) {
    if (!membership.active || membership.agentDbId !== params.activeActor.id) {
      continue;
    }
    membershipByChannelId.set(membership.channelId, membership);
  }

  const adminChannelIds = new Set(
    [...membershipByChannelId.entries()]
      .filter(([, membership]) => enumTag(membership.permission) === 'Admin')
      .map(([channelId]) => channelId)
  );

  const pendingApprovalsByChannelId = new Map<bigint, number>();
  for (const request of params.requests) {
    if (
      request.status.tag !== 'Pending' ||
      !adminChannelIds.has(request.channelId)
    ) {
      continue;
    }
    pendingApprovalsByChannelId.set(
      request.channelId,
      (pendingApprovalsByChannelId.get(request.channelId) ?? 0) + 1
    );
  }

  const channelSummaries = params.channels
    .filter(channel => membershipByChannelId.has(channel.id))
    .sort((left, right) => {
      const leftMembership = membershipByChannelId.get(left.id);
      const rightMembership = membershipByChannelId.get(right.id);
      const leftAdmin = enumTag(leftMembership?.permission) === 'Admin';
      const rightAdmin = enumTag(rightMembership?.permission) === 'Admin';
      if (leftAdmin !== rightAdmin) {
        return leftAdmin ? -1 : 1;
      }

      const byTime = compareBigIntDesc(
        left.lastMessageAt.microsSinceUnixEpoch,
        right.lastMessageAt.microsSinceUnixEpoch
      );
      if (byTime !== 0) {
        return byTime;
      }
      return left.slug.localeCompare(right.slug);
    })
    .map(channel => {
      const membership = membershipByChannelId.get(channel.id);
      return {
        id: channel.id.toString(),
        slug: channel.slug,
        title: channel.title ?? null,
        description: channel.description ?? null,
        accessMode: channelAccessModeToCli(channel.accessMode),
        discoverable: channel.discoverable,
        messageCount: channel.messageCount.toString(),
        lastMessageAt: timestampToISOString(channel.lastMessageAt),
        permission: channelPermissionToCli(membership?.permission),
        canSend:
          enumTag(membership?.permission) === 'Admin' ||
          enumTag(membership?.permission) === 'ReadWrite',
        isAdmin: enumTag(membership?.permission) === 'Admin',
        actorSlug: params.activeActor.slug,
        pendingApprovals: pendingApprovalsByChannelId.get(channel.id) ?? 0,
      } satisfies ShellChannelSummary;
    });

  const approvals = params.requests
    .filter(request => {
      return (
        request.status.tag === 'Pending' &&
        adminChannelIds.has(request.channelId)
      );
    })
    .sort((left, right) => {
      const byUpdated = compareBigIntDesc(
        left.updatedAt.microsSinceUnixEpoch,
        right.updatedAt.microsSinceUnixEpoch
      );
      if (byUpdated !== 0) {
        return byUpdated;
      }
      return compareBigIntDesc(left.id, right.id);
    })
    .map(request => ({
      id: request.id.toString(),
      channelId: request.channelId.toString(),
      channelSlug: params.channels.find(channel => channel.id === request.channelId)?.slug ?? `channel:${request.channelId.toString()}`,
      channelTitle: params.channels.find(channel => channel.id === request.channelId)?.title ?? null,
      requesterAgentDbId: request.requesterAgentDbId.toString(),
      requesterSlug: `agent:${request.requesterAgentDbId.toString()}`,
      requesterDisplayName: null,
      permission: channelPermissionToCli(request.permission),
      status: 'pending',
      createdAt: timestampToISOString(request.createdAt),
      updatedAt: timestampToISOString(request.updatedAt),
      adminAgentSlug: params.activeActor.slug,
    }) satisfies ShellChannelApprovalSummary);

  return {
    channels: channelSummaries,
    approvals,
    pendingApprovalCount: approvals.length,
  };
}

function buildAttentionItems(params: {
  activeInbox: OwnedInboxSummary;
  requests: ShellRequestSummary[];
  channelApprovalCount: number;
  securityState: ShellSecurityState;
  connectionHealth: RootShellConnectionHealth;
  pendingBackupPrompt: string | null;
}): DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = [];

  if (params.securityState.status !== 'healthy') {
    items.push({
      id: `security:${params.securityState.status}`,
      title: params.securityState.title,
      description: params.securityState.description,
      severity: params.securityState.status === 'missing' ? 'critical' : 'warning',
      targetTab: 'account',
      targetSection: 'security',
    });
  }

  if (params.connectionHealth === 'reconnecting') {
    items.push({
      id: 'connection:reconnecting',
      title: 'Connection is still syncing',
      description:
        'Live data is reconnecting. Messages and approvals may lag briefly.',
      severity: 'warning',
      targetTab: 'account',
      targetSection: 'session',
    });
  } else if (params.connectionHealth === 'error') {
    items.push({
      id: 'connection:error',
      title: 'Live connection needs attention',
      description:
        'Account login is active, but the live SpacetimeDB session has an error.',
      severity: 'critical',
      targetTab: 'account',
      targetSection: 'session',
    });
  }

  const incomingPendingCount = params.requests.filter(
    request => request.direction === 'incoming'
  ).length;
  if (incomingPendingCount > 0) {
    items.push({
      id: 'requests:pending',
      title: `${incomingPendingCount.toString()} pending approval${incomingPendingCount === 1 ? '' : 's'}`,
      description: 'Open Pending to approve or reject requests.',
      severity: 'warning',
      targetTab: 'inboxes',
      targetSection: 'pending',
    });
  }

  if (params.channelApprovalCount > 0) {
    items.push({
      id: 'channels:pending',
      title: `${params.channelApprovalCount.toString()} pending channel approval${params.channelApprovalCount === 1 ? '' : 's'}`,
      description: 'Open Channels to approve or reject join requests.',
      severity: 'warning',
      targetTab: 'channels',
      targetSection: 'approvals',
    });
  }

  if (!params.activeInbox.managed) {
    items.push({
      id: 'agent:registration',
      title: 'Managed agent registration is still missing',
      description:
        'Open Agents to register or sync this agent.',
      severity: 'info',
      targetTab: 'agents',
    });
  }

  if (params.pendingBackupPrompt) {
    items.push({
      id: 'backup:recommended',
      title: 'Create an encrypted key backup',
      description: params.pendingBackupPrompt,
      severity: 'info',
      targetTab: 'account',
      targetSection: 'security',
    });
  }

  return items;
}

export function buildRootShellViewModel(params: {
  rows: ShellRows;
  email: string;
  activeInboxSlug?: string | null;
  securityState: ShellSecurityState;
  connectionHealth: RootShellConnectionHealth;
  pendingBackupPrompt?: string | null;
}): RootShellViewModel | null {
  const defaultActor = findDefaultActorByEmail(params.rows.actors, params.email);
  if (!defaultActor) {
    return null;
  }

  const ownedActors = params.rows.actors
    .filter(actor => actor.accountId === defaultActor.accountId)
    .sort(sortOwnedActors);
  const usableOwnedActors = ownedActors.filter(actor => !isDeregisteredOwnedActor(actor));
  const activeActor =
    usableOwnedActors.find(actor => actor.slug === params.activeInboxSlug) ??
    usableOwnedActors[0] ??
    null;
  if (!activeActor) {
    return null;
  }

  const ownActorIds = buildOwnActorIds(params.rows.actors, activeActor.accountId);
  const activeParticipantsByThreadId = buildParticipantsByThreadId(
    params.rows.participants.filter(participant => participant.active)
  );
  const actorsById = new Map(params.rows.actors.map(actor => [actor.id, actor] as const));
  const readStateByThreadId = buildReadStateByThreadId(params.rows.readStates, activeActor.id);

  const threads = params.rows.threads
    .filter(thread =>
      (activeParticipantsByThreadId.get(thread.id) ?? []).some(
        participant => participant.agentDbId === activeActor.id
      )
    )
    .sort((left, right) => {
      const byTime = compareBigIntDesc(
        left.lastMessageAt.microsSinceUnixEpoch,
        right.lastMessageAt.microsSinceUnixEpoch
      );
      if (byTime !== 0) {
        return byTime;
      }
      return compareBigIntDesc(left.id, right.id);
    })
    .map(thread => ({
      id: thread.id.toString(),
      kind: enumTag(thread.kind).toLowerCase(),
      label: summarizeThread(
        thread,
        activeParticipantsByThreadId.get(thread.id) ?? [],
        actorsById,
        ownActorIds
      ),
      unreadMessages: (() => {
        const readState = readStateByThreadId.get(thread.id);
        if (readState?.archived) {
          return 0;
        }
        const lastAssigned = thread.lastMessageId;
        return lastAssigned > (readState?.lastReadMessageId ?? 0n) ? 1 : 0;
      })(),
      archived: readStateByThreadId.get(thread.id)?.archived ?? false,
      locked: enumTag(thread.kind) === 'Direct',
      participantCount: Number(thread.activeParticipantCount),
      participants: listThreadParticipants({
        threadId: thread.id,
        participantsByThreadId: activeParticipantsByThreadId,
        actorsById,
      }),
      lastMessageAt: timestampToISOString(thread.lastMessageAt),
      lastMessageId: thread.lastMessageId.toString(),
    }) satisfies ShellThreadSummary);

  const requests = params.rows.contactRequests
    .filter(request => request.status.tag === 'Pending')
    .filter(request => {
      return (
        request.requesterAgentDbId === activeActor.id ||
        request.targetAgentDbId === activeActor.id
      );
    })
    .sort((left, right) => {
      const byUpdated = compareBigIntDesc(
        left.updatedAt.microsSinceUnixEpoch,
        right.updatedAt.microsSinceUnixEpoch
      );
      if (byUpdated !== 0) {
        return byUpdated;
      }
      return compareBigIntDesc(left.id, right.id);
    })
    .map(request => ({
      id: request.id.toString(),
      threadId: request.threadId.toString(),
      direction:
        request.targetAgentDbId === activeActor.id ? 'incoming' : 'outgoing',
      status: contactRequestStatusToCli(request.status),
      messageCount: '0',
      requesterSlug: request.requesterSlug,
      requesterDisplayName: actorsById.get(request.requesterAgentDbId)?.displayName ?? null,
      targetSlug: request.targetSlug,
      targetDisplayName: actorsById.get(request.targetAgentDbId)?.displayName ?? null,
      updatedAt: timestampToISOString(request.updatedAt),
    }) satisfies ShellRequestSummary);

  const allowlist = params.rows.allowlistEntries
    .filter(entry => entry.accountId === activeActor.accountId)
    .sort((left, right) => {
      const byCreated = compareBigIntDesc(
        left.createdAt.microsSinceUnixEpoch,
        right.createdAt.microsSinceUnixEpoch
      );
      if (byCreated !== 0) {
        return byCreated;
      }
      return compareBigIntDesc(left.id, right.id);
    })
    .map(entry => {
      const kind = allowlistKindToCli(entry.kind);
      return {
        id: entry.id.toString(),
        kind,
        value: kind === 'agent' ? (entry.agentPublicIdentity ?? '') : (entry.email ?? ''),
        label: kind === 'agent' ? entry.agentSlug ?? null : entry.email ?? null,
        createdAt: timestampToISOString(entry.createdAt),
      } satisfies ShellAllowlistSummary;
    });

  const pendingShareCountByDeviceId = new Map<string, number>();
  for (const request of params.rows.deviceRequests) {
    if (!request.consumedAt && !request.approvedAt && isTimestampInFuture(request.expiresAt)) {
      pendingShareCountByDeviceId.set(
        request.deviceId,
        (pendingShareCountByDeviceId.get(request.deviceId) ?? 0) + 1
      );
    }
  }

  const devices = params.rows.devices
    .filter(device => device.accountId === activeActor.accountId)
    .sort((left, right) => {
      const byUpdated = compareBigIntDesc(
        left.lastSeenAt.microsSinceUnixEpoch,
        right.lastSeenAt.microsSinceUnixEpoch
      );
      if (byUpdated !== 0) {
        return byUpdated;
      }
      return left.deviceId.localeCompare(right.deviceId);
    })
    .map(device => ({
      deviceId: device.deviceId,
      label: device.label ?? null,
      platform: device.platform ?? null,
      status: enumTag(device.status).toLowerCase(),
      approvedAt: device.approvedAt ? timestampToISOString(device.approvedAt) : null,
      revokedAt: device.revokedAt ? timestampToISOString(device.revokedAt) : null,
      lastSeenAt: timestampToISOString(device.lastSeenAt),
      pendingShareCount: pendingShareCountByDeviceId.get(device.deviceId) ?? 0,
    }) satisfies ShellDeviceSummary);

  const deviceRequests = params.rows.deviceRequests
    .filter(request => !request.consumedAt && isTimestampInFuture(request.expiresAt))
    .sort((left, right) => {
      const byCreated = compareBigIntDesc(
        left.createdAt.microsSinceUnixEpoch,
        right.createdAt.microsSinceUnixEpoch
      );
      if (byCreated !== 0) {
        return byCreated;
      }
      return compareBigIntDesc(left.id, right.id);
    })
    .map(request => ({
      id: request.id.toString(),
      deviceId: request.deviceId,
      label: null,
      platform: null,
      expiresAt: timestampToISOString(request.expiresAt),
      createdAt: timestampToISOString(request.createdAt),
      approvedAt: request.approvedAt ? timestampToISOString(request.approvedAt) : null,
      consumedAt: request.consumedAt ? timestampToISOString(request.consumedAt) : null,
    }) satisfies ShellDeviceRequestSummary);

  const activeInbox = toOwnedInboxSummary(activeActor);
  const channelState = buildChannelState({
    channels: params.rows.channels,
    memberships: params.rows.channelMemberships,
    requests: params.rows.channelJoinRequests,
    activeActor,
  });

  return {
    activeInbox,
    ownedInboxes: ownedActors.map(toOwnedInboxSummary),
    unreadCount: threads.reduce((total, thread) => total + thread.unreadMessages, 0),
    pendingRequestCount: requests.length,
    dashboard: {
      attentionItems: buildAttentionItems({
        activeInbox,
        requests,
        channelApprovalCount: channelState.pendingApprovalCount,
        securityState: params.securityState,
        connectionHealth: params.connectionHealth,
        pendingBackupPrompt: params.pendingBackupPrompt ?? null,
      }),
      recentThreads: threads.slice(0, 5),
      recentRequests: requests.slice(0, 3),
    },
    inboxes: {
      sections: buildInboxSections({
        threads,
        requests,
      }),
      threads,
      requests,
      allowlist,
    },
    channels: channelState,
    agents: {
      agentSummaries: ownedActors.map(toOwnedInboxSummary),
    },
    account: {
      securityState: params.securityState,
      devices,
      deviceRequests,
    },
  };
}
