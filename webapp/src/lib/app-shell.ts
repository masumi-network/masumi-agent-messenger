import type { ActorLike } from '../../../shared/inbox-state';
import {
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import { normalizeEmail } from '../../../shared/inbox-slug';
import { compareTimestampsDesc, type TimestampLike } from '../../../shared/spacetime-time';

export type DashboardModal = 'recovery' | 'backups';
export type DefaultKeyIssue = 'missing' | 'mismatch' | null;
export type SecurityPanel = 'recovery' | 'backups';
export type InboxComposeMode = 'direct' | 'group';
type InboxComposeModeInput = InboxComposeMode | 'add';
export type WorkspaceTab = 'inbox' | 'approvals';
export type AppShellSection = 'inbox' | 'discover' | 'agents' | 'security' | 'channels';

export type ChannelNavEntry = {
  channelId: bigint;
  slug: string;
  title: string | null;
  permission: string;
  isAdmin: boolean;
  pendingApprovals: number;
};

type ChannelNavChannelLike = {
  id: bigint;
  slug: string;
  title?: string | null;
};

type ChannelNavMembershipLike = {
  channelId: bigint;
  agentDbId: bigint;
  permission: string;
  active: boolean;
};

type ChannelNavJoinRequestLike = {
  channelId: bigint;
  direction: string;
  status: string;
};

function channelPermissionRank(permission: string): number {
  if (permission === 'admin') return 3;
  if (permission === 'read_write') return 2;
  if (permission === 'read') return 1;
  return 0;
}

export function buildChannelNavEntries<
  Channel extends ChannelNavChannelLike,
  Membership extends ChannelNavMembershipLike,
  JoinRequest extends ChannelNavJoinRequestLike,
>(params: {
  channels: Channel[];
  memberships: Membership[];
  joinRequests: JoinRequest[];
  ownedActorIds: Set<bigint>;
}): ChannelNavEntry[] {
  const channelById = new Map(params.channels.map(channel => [channel.id, channel]));
  const byChannelId = new Map<bigint, ChannelNavEntry>();

  for (const membership of params.memberships) {
    if (!params.ownedActorIds.has(membership.agentDbId) || !membership.active) {
      continue;
    }
    const channel = channelById.get(membership.channelId);
    if (!channel) {
      continue;
    }
    const existing = byChannelId.get(membership.channelId);
    if (
      existing &&
      channelPermissionRank(existing.permission) >= channelPermissionRank(membership.permission)
    ) {
      continue;
    }
    byChannelId.set(membership.channelId, {
      channelId: membership.channelId,
      slug: channel.slug,
      title: channel.title ?? null,
      permission: membership.permission,
      isAdmin: membership.permission === 'admin',
      pendingApprovals: existing?.pendingApprovals ?? 0,
    });
  }

  for (const request of params.joinRequests) {
    if (request.direction !== 'incoming' || request.status !== 'pending') {
      continue;
    }
    const entry = byChannelId.get(request.channelId);
    if (!entry || !entry.isAdmin) {
      continue;
    }
    entry.pendingApprovals += 1;
  }

  return Array.from(byChannelId.values()).sort((left, right) => {
    if (left.isAdmin !== right.isAdmin) {
      return left.isAdmin ? -1 : 1;
    }
    return left.slug.localeCompare(right.slug);
  });
}
export type WorkspaceSearch = {
  thread: string | undefined;
  compose: InboxComposeMode | undefined;
  lookup: string | undefined;
  tab: Exclude<WorkspaceTab, 'inbox'> | undefined;
};

export type OwnedInboxActorLike = ActorLike & {
  masumiRegistrationNetwork?: string | null;
  masumiInboxAgentId?: string | null;
  masumiAgentIdentifier?: string | null;
  masumiRegistrationState?: string | null;
};

export type OwnedInboxAgentEntry<Actor extends OwnedInboxActorLike> = {
  actor: Actor;
  managed: boolean;
  registered: boolean;
};

export type ContactRequestLike = {
  id: bigint;
  requesterAgentDbId: bigint;
  requesterSlug: string;
  targetAgentDbId: bigint;
  targetSlug: string;
  direction: string;
  status: string;
  updatedAt: TimestampLike;
};

export type ThreadInviteLike = {
  id: bigint;
  inviterAgentDbId: bigint;
  inviterSlug: string;
  inviteeAgentDbId: bigint;
  inviteeSlug: string;
  status: string;
  updatedAt: TimestampLike;
};

export type ContactAllowlistEntryLike = {
  id: bigint;
  inboxId: bigint;
  createdAt: TimestampLike;
};

export type SessionOwnedInboxLike = {
  id: bigint;
  normalizedEmail: string;
  authIssuer: string;
  authSubject: string;
};

export type OwnedInboxWithOwnerIdentityLike = SessionOwnedInboxLike & {
  ownerIdentity: {
    toHexString(): string;
  };
};

export type BrowserSessionLike = {
  user: {
    email: string | null;
    issuer: string;
    subject: string;
  };
};

export function parseDashboardModal(value: unknown): DashboardModal | undefined {
  return value === 'recovery' || value === 'backups' ? value : undefined;
}

export function resolveDashboardModal(params: {
  requestedModal?: DashboardModal | null;
  bootstrapTriggered?: boolean;
  defaultKeyIssue: DefaultKeyIssue;
}): DashboardModal | null {
  if (params.requestedModal) {
    return params.requestedModal;
  }

  if (params.bootstrapTriggered && params.defaultKeyIssue) {
    return 'recovery';
  }

  return null;
}

export type AgentsTab = 'discover' | 'agents';

export function parseAgentsTab(value: unknown): AgentsTab {
  return value === 'agents' || value === 'register' ? 'agents' : 'discover';
}

export function deriveAppShellSection(pathname: string): AppShellSection {
  if (pathname === '/agents') {
    return 'agents';
  }

  if (pathname === '/discover') {
    return 'discover';
  }

  if (pathname === '/security') {
    return 'security';
  }

  if (pathname === '/channels' || pathname.startsWith('/channels/')) {
    return 'channels';
  }

  return 'inbox';
}

export function parseOptionalSlug(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function parseOptionalThreadId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function parseOptionalLookup(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseComposeMode(value: unknown): InboxComposeMode | undefined {
  if (value === 'direct' || value === 'group') {
    return value;
  }
  if (value === 'add') {
    return 'direct';
  }
  return undefined;
}

export function parseSecurityPanel(value: unknown): SecurityPanel | undefined {
  return value === 'recovery' || value === 'backups' ? value : undefined;
}

export function parseWorkspaceTab(
  value: unknown
): Exclude<WorkspaceTab, 'inbox'> | undefined {
  return value === 'approvals' ? value : undefined;
}

export function findSessionOwnedInbox<Inbox extends SessionOwnedInboxLike>(params: {
  inboxes: Inbox[];
  session: BrowserSessionLike | null;
}): Inbox | null {
  const email = params.session?.user.email ?? null;
  if (!email) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);
  return (
    params.inboxes.find(inbox => {
      return (
        inbox.normalizedEmail === normalizedEmail &&
        inbox.authIssuer === params.session?.user.issuer &&
        inbox.authSubject === params.session?.user.subject
      );
    }) ?? null
  );
}

export function findDefaultOwnedActor<Actor extends ActorLike>(
  actors: Actor[],
  inboxId: bigint | null
): Actor | null {
  if (inboxId === null) {
    return null;
  }

  return actors.find(actor => actor.inboxId === inboxId && actor.isDefault) ?? null;
}

export function describeLocalVaultRequirement(params: {
  initialized: boolean;
  phrase: string;
}): string {
  return `${params.initialized ? 'Unlock the local key vault' : 'Create a local key vault'} ${params.phrase}.`;
}

export function buildOwnedInboxAgentEntries<Actor extends OwnedInboxActorLike>(params: {
  actors: Actor[];
  ownInboxId: bigint | null;
  normalizedEmail: string;
}): OwnedInboxAgentEntry<Actor>[] {
  return params.actors
    .filter(actor => {
      if (params.ownInboxId !== null) {
        return actor.inboxId === params.ownInboxId;
      }

      return actor.normalizedEmail === params.normalizedEmail;
    })
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }

      return left.slug.localeCompare(right.slug);
    })
    .map(actor => {
      const metadata = readActorRegistrationMetadata(actor);
      const registration = registrationResultFromMetadata(metadata);
      return {
        actor,
        managed: metadata !== null,
        registered: registration.status === 'registered',
      };
    });
}

function readActorRegistrationMetadata(
  actor: OwnedInboxActorLike
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

export function resolveShellInboxSlug<Actor extends OwnedInboxActorLike>(
  ownedEntries: OwnedInboxAgentEntry<Actor>[],
  preferredSlug?: string | null
): string | null {
  if (preferredSlug && ownedEntries.some(entry => entry.actor.slug === preferredSlug)) {
    return preferredSlug;
  }

  return ownedEntries[0]?.actor.slug ?? null;
}

export function buildWorkspaceSearch(params: {
  thread?: string;
  compose?: InboxComposeModeInput;
  lookup?: string;
  tab?: WorkspaceTab;
}): WorkspaceSearch {
  const tab = params.tab && params.tab !== 'inbox' ? params.tab : undefined;
  const compose =
    params.compose === 'add' ? 'direct' : params.compose;

  return {
    thread: params.thread,
    compose,
    lookup: params.lookup,
    tab,
  };
}

export function resolveWorkspaceSnapshot<
  Inbox extends SessionOwnedInboxLike,
  Actor extends OwnedInboxActorLike,
  Request extends ContactRequestLike,
  Invite extends ThreadInviteLike,
>(params: {
  inboxes: Inbox[];
  actors: Actor[];
  contactRequests: Request[];
  threadInvites?: Invite[];
  session: BrowserSessionLike | null;
  selectedSlug?: string | null;
}): {
  normalizedEmail: string;
  ownedInbox: Inbox | null;
  existingDefaultActor: Actor | null;
  ownedInboxAgents: OwnedInboxAgentEntry<Actor>[];
  selectedActor: Actor | null;
  shellInboxSlug: string | null;
  approvalView: {
    incoming: Request[];
    outgoing: Request[];
    incomingThreadInvites: Invite[];
    outgoingThreadInvites: Invite[];
    pendingIncomingCount: number;
    pendingOutgoingCount: number;
  };
} {
  const normalizedEmail = normalizeEmail(params.session?.user.email ?? '');
  const ownedInbox = findSessionOwnedInbox({
    inboxes: params.inboxes,
    session: params.session,
  });
  const existingDefaultActor = findDefaultOwnedActor(
    params.actors,
    ownedInbox?.id ?? null
  );
  const ownedInboxAgents = buildOwnedInboxAgentEntries({
    actors: params.actors,
    ownInboxId: ownedInbox?.id ?? null,
    normalizedEmail,
  });
  const selectedActor =
    (params.selectedSlug
      ? ownedInboxAgents.find(entry => entry.actor.slug === params.selectedSlug)?.actor
      : null) ??
    existingDefaultActor ??
    null;
  const shellInboxSlug = resolveShellInboxSlug(
    ownedInboxAgents,
    selectedActor?.slug ?? existingDefaultActor?.slug ?? null
  );
  const approvalView = buildApprovalView({
    contactRequests: params.contactRequests,
    threadInvites: params.threadInvites ?? [],
    ownedActors: ownedInboxAgents.map(entry => entry.actor),
    selectedSlug: params.selectedSlug ?? undefined,
  });

  return {
    normalizedEmail,
    ownedInbox,
    existingDefaultActor,
    ownedInboxAgents,
    selectedActor,
    shellInboxSlug,
    approvalView,
  };
}

export function evaluateWorkspaceWriteAccess<
  Inbox extends OwnedInboxWithOwnerIdentityLike,
>(params: {
  connected: boolean;
  session: BrowserSessionLike | null;
  normalizedSessionEmail: string | null;
  inbox: Inbox | null;
  connectionIdentity: { toHexString(): string } | null;
  hasActor?: boolean;
}): {
  canWrite: boolean;
  reason: string | null;
} {
  if (!params.hasActor) {
    return {
      canWrite: false,
      reason: 'Select an inbox actor before writing inbox data.',
    };
  }

  if (!params.connected) {
    return {
      canWrite: false,
      reason: 'Wait for the live connection before writing inbox data.',
    };
  }

  if (!params.session) {
    return {
      canWrite: false,
      reason: 'Sign in before writing to inbox data.',
    };
  }

  if (!params.inbox) {
    return {
      canWrite: false,
      reason: 'Waiting for live inbox ownership data before enabling writes.',
    };
  }

  if (
    !params.normalizedSessionEmail ||
    params.normalizedSessionEmail !== params.inbox.normalizedEmail
  ) {
    return {
      canWrite: false,
      reason: 'Current OIDC session email does not own this inbox slug.',
    };
  }

  if (
    params.session.user.issuer !== params.inbox.authIssuer ||
    params.session.user.subject !== params.inbox.authSubject
  ) {
    return {
      canWrite: false,
      reason: 'Current OIDC subject is not authorized to write to this inbox slug.',
    };
  }

  if (
    !params.connectionIdentity ||
    params.connectionIdentity.toHexString() !==
      params.inbox.ownerIdentity.toHexString()
  ) {
    return {
      canWrite: false,
      reason:
        'The live SpacetimeDB connection identity does not match this inbox owner.',
    };
  }

  return {
    canWrite: true,
    reason: null,
  };
}

export function buildApprovalView<
  Actor extends Pick<OwnedInboxActorLike, 'id' | 'slug'>,
  Request extends ContactRequestLike,
  Invite extends ThreadInviteLike,
>(params: {
  contactRequests: Request[];
  threadInvites?: Invite[];
  ownedActors: Actor[];
  selectedSlug?: string | null;
}): {
  incoming: Request[];
  outgoing: Request[];
  incomingThreadInvites: Invite[];
  outgoingThreadInvites: Invite[];
  pendingIncomingCount: number;
  pendingOutgoingCount: number;
} {
  const ownedActorIds = new Set(params.ownedActors.map(actor => actor.id));
  const selectedSlug = params.selectedSlug ?? null;

  const relevantRequests = params.contactRequests
    .filter(request => {
      return (
        ownedActorIds.has(request.targetAgentDbId) ||
        ownedActorIds.has(request.requesterAgentDbId)
      );
    })
    .filter(request => {
      if (!selectedSlug) {
        return true;
      }

      return request.targetSlug === selectedSlug || request.requesterSlug === selectedSlug;
    })
    .sort((left, right) => {
      const byUpdatedAt = compareTimestampsDesc(left.updatedAt, right.updatedAt);
      if (byUpdatedAt !== 0) {
        return byUpdatedAt;
      }

      return Number(right.id - left.id);
    });

  const incoming = relevantRequests.filter(request => request.direction === 'incoming');
  const outgoing = relevantRequests.filter(request => request.direction === 'outgoing');
  const relevantInvites = (params.threadInvites ?? [])
    .filter(invite => {
      return (
        ownedActorIds.has(invite.inviteeAgentDbId) ||
        ownedActorIds.has(invite.inviterAgentDbId)
      );
    })
    .filter(invite => {
      if (!selectedSlug) {
        return true;
      }

      return invite.inviteeSlug === selectedSlug || invite.inviterSlug === selectedSlug;
    })
    .sort((left, right) => {
      const byUpdatedAt = compareTimestampsDesc(left.updatedAt, right.updatedAt);
      if (byUpdatedAt !== 0) {
        return byUpdatedAt;
      }

      return Number(right.id - left.id);
    });
  const incomingThreadInvites = relevantInvites.filter(invite =>
    ownedActorIds.has(invite.inviteeAgentDbId)
  );
  const outgoingThreadInvites = relevantInvites.filter(invite =>
    ownedActorIds.has(invite.inviterAgentDbId)
  );

  return {
    incoming,
    outgoing,
    incomingThreadInvites,
    outgoingThreadInvites,
    pendingIncomingCount:
      incoming.filter(request => request.status === 'pending').length +
      incomingThreadInvites.filter(invite => invite.status === 'pending').length,
    pendingOutgoingCount:
      outgoing.filter(request => request.status === 'pending').length +
      outgoingThreadInvites.filter(invite => invite.status === 'pending').length,
  };
}

export function filterAllowlistEntriesByInboxId<Entry extends ContactAllowlistEntryLike>(
  entries: Entry[],
  inboxId: bigint | null
): Entry[] {
  if (inboxId === null) {
    return [];
  }

  return entries
    .filter(entry => entry.inboxId === inboxId)
    .sort((left, right) => {
      const byCreatedAt = compareTimestampsDesc(left.createdAt, right.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }

      return Number(right.id - left.id);
    });
}
