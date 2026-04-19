import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import { isTimestampInFuture, timestampToISOString } from '../../../shared/spacetime-time';
import type {
  VisibleAgentRow,
  VisibleThreadParticipantRow,
  VisibleThreadReadStateRow,
  VisibleMessageRow,
} from '../../../webapp/src/module_bindings/types';
import type { ShellRows } from './spacetimedb';

export type OwnedInboxSummary = {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  isDefault: boolean;
  managed: boolean;
  registered: boolean;
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
  lastMessageSeq: string;
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

export type DashboardAttentionItem = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  targetTab: 'dashboard' | 'inboxes' | 'agents' | 'account';
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

function sortOwnedActors(left: VisibleAgentRow, right: VisibleAgentRow): number {
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

function buildUnreadMessagesForActor(params: {
  actor: VisibleAgentRow;
  actors: VisibleAgentRow[];
  readStates: VisibleThreadReadStateRow[];
  messages: VisibleMessageRow[];
}): VisibleMessageRow[] {
  const ownActorIds = buildOwnActorIds(params.actors, params.actor.inboxId);
  const archivedThreadIds = new Set(
    params.readStates
      .filter(readState => readState.agentDbId === params.actor.id && readState.archived)
      .map(readState => readState.threadId)
  );
  const lastReadByThreadId = new Map<bigint, bigint>();
  for (const readState of params.readStates) {
    if (readState.agentDbId !== params.actor.id || readState.archived) {
      continue;
    }
    lastReadByThreadId.set(readState.threadId, readState.lastReadThreadSeq ?? 0n);
  }

  return params.messages
    .filter(message => !archivedThreadIds.has(message.threadId))
    .filter(message => !ownActorIds.has(message.senderAgentDbId))
    .filter(message => message.threadSeq > (lastReadByThreadId.get(message.threadId) ?? 0n))
    .sort((left, right) => {
      const byTime = compareBigIntDesc(
        left.createdAt.microsSinceUnixEpoch,
        right.createdAt.microsSinceUnixEpoch
      );
      if (byTime !== 0) {
        return byTime;
      }
      return compareBigIntDesc(left.threadSeq, right.threadSeq);
    });
}

function toOwnedInboxSummary(actor: VisibleAgentRow): OwnedInboxSummary {
  const metadata = readActorRegistrationMetadata(actor);
  const registration = registrationResultFromMetadata(metadata);
  return {
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    managed: metadata !== null,
    registered: registration.status === 'registered',
    publicDescription: actor.publicDescription ?? null,
    publicLinkedEmailEnabled: actor.publicLinkedEmailEnabled,
  };
}

function readActorRegistrationMetadata(
  actor: VisibleAgentRow
): MasumiActorRegistrationMetadata | null {
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState:
      actor.masumiRegistrationState && isMasumiInboxAgentState(actor.masumiRegistrationState)
        ? actor.masumiRegistrationState
        : undefined,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

function listThreadParticipants(params: {
  threadId: bigint;
  participantsByThreadId: Map<bigint, VisibleThreadParticipantRow[]>;
  actorsById: Map<bigint, VisibleAgentRow>;
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

function buildAttentionItems(params: {
  activeInbox: OwnedInboxSummary;
  requests: ShellRequestSummary[];
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

  if (params.connectionHealth === 'reconnecting' || params.connectionHealth === 'connecting') {
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

  if (params.requests.length > 0) {
    items.push({
      id: 'requests:pending',
      title: `${params.requests.length.toString()} pending approval${params.requests.length === 1 ? '' : 's'}`,
      description: 'Open Pending to approve or reject requests.',
      severity: 'warning',
      targetTab: 'inboxes',
      targetSection: 'pending',
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
  normalizedEmail: string;
  activeInboxSlug?: string | null;
  securityState: ShellSecurityState;
  connectionHealth: RootShellConnectionHealth;
  pendingBackupPrompt?: string | null;
}): RootShellViewModel | null {
  const defaultActor = findDefaultActorByEmail(params.rows.actors, params.normalizedEmail);
  if (!defaultActor) {
    return null;
  }

  const ownedActors = params.rows.actors
    .filter(actor => actor.inboxId === defaultActor.inboxId)
    .sort(sortOwnedActors);
  const activeActor =
    ownedActors.find(actor => actor.slug === params.activeInboxSlug) ?? ownedActors[0] ?? defaultActor;

  const ownActorIds = buildOwnActorIds(params.rows.actors, activeActor.inboxId);
  const unreadMessages = buildUnreadMessagesForActor({
    actor: activeActor,
    actors: params.rows.actors,
    readStates: params.rows.readStates,
    messages: params.rows.messages,
  });
  const unreadCountByThreadId = new Map<bigint, number>();
  for (const message of unreadMessages) {
    unreadCountByThreadId.set(
      message.threadId,
      (unreadCountByThreadId.get(message.threadId) ?? 0) + 1
    );
  }

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
      kind: thread.kind,
      label: summarizeThread(
        thread,
        activeParticipantsByThreadId.get(thread.id) ?? [],
        actorsById,
        ownActorIds
      ),
      unreadMessages: unreadCountByThreadId.get(thread.id) ?? 0,
      archived: readStateByThreadId.get(thread.id)?.archived ?? false,
      locked: thread.membershipLocked,
      participantCount: (activeParticipantsByThreadId.get(thread.id) ?? []).length,
      participants: listThreadParticipants({
        threadId: thread.id,
        participantsByThreadId: activeParticipantsByThreadId,
        actorsById,
      }),
      lastMessageAt: timestampToISOString(thread.lastMessageAt),
      lastMessageSeq: thread.lastMessageSeq.toString(),
    }) satisfies ShellThreadSummary);

  const requests = params.rows.contactRequests
    .filter(request => request.status === 'pending')
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
      direction: request.direction as ShellRequestSummary['direction'],
      status: request.status as ShellRequestSummary['status'],
      messageCount: request.messageCount.toString(),
      requesterSlug: request.requesterSlug,
      requesterDisplayName: request.requesterDisplayName ?? null,
      targetSlug: request.targetSlug,
      targetDisplayName: request.targetDisplayName ?? null,
      updatedAt: timestampToISOString(request.updatedAt),
    }) satisfies ShellRequestSummary);

  const allowlist = params.rows.allowlistEntries
    .filter(entry => entry.inboxId === activeActor.inboxId)
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
    .map(entry => ({
      id: entry.id.toString(),
      kind: entry.kind as ShellAllowlistSummary['kind'],
      value:
        entry.kind === 'agent'
          ? (entry.agentPublicIdentity ?? '')
          : (entry.displayEmail ?? entry.normalizedEmail ?? ''),
      label:
        entry.kind === 'agent'
          ? (entry.agentDisplayName ?? entry.agentSlug ?? null)
          : (entry.displayEmail ?? null),
      createdAt: timestampToISOString(entry.createdAt),
    }) satisfies ShellAllowlistSummary);

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
    .filter(device => device.inboxId === activeActor.inboxId)
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
      status: device.status,
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
      label: request.label ?? null,
      platform: request.platform ?? null,
      expiresAt: timestampToISOString(request.expiresAt),
      createdAt: timestampToISOString(request.createdAt),
      approvedAt: request.approvedAt ? timestampToISOString(request.approvedAt) : null,
      consumedAt: request.consumedAt ? timestampToISOString(request.consumedAt) : null,
    }) satisfies ShellDeviceRequestSummary);

  const activeInbox = toOwnedInboxSummary(activeActor);

  return {
    activeInbox,
    ownedInboxes: ownedActors.map(toOwnedInboxSummary),
    unreadCount: unreadMessages.length,
    pendingRequestCount: requests.length,
    dashboard: {
      attentionItems: buildAttentionItems({
        activeInbox,
        requests,
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
