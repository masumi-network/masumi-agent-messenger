import type { ActorLike } from '../../../shared/inbox-state';
import {
  isDeregisteringOrDeregisteredMasumiRegistrationMetadata,
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
export type WorkspaceTab = 'inbox' | 'approvals' | 'settings';
export type AppShellSection = 'inbox' | 'discover' | 'agents' | 'security' | 'channels';

type ChannelPermissionTag = { tag: string };

export type ChannelNavEntry = {
  channelId: bigint;
  slug: string;
  title: string | null;
  permission: ChannelPermissionTag;
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
  permission: ChannelPermissionTag;
  active: boolean;
};

type ChannelNavJoinRequestLike = {
  channelId: bigint;
  requesterAgentDbId: bigint;
  status: { tag: string };
};

function channelPermissionRank(permission: ChannelPermissionTag): number {
  if (permission.tag === 'Admin') return 3;
  if (permission.tag === 'ReadWrite') return 2;
  if (permission.tag === 'Read') return 1;
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
      isAdmin: membership.permission.tag === 'Admin',
      pendingApprovals: existing?.pendingApprovals ?? 0,
    });
  }

  for (const request of params.joinRequests) {
    // Direction is "incoming" relative to the caller when the requester is
    // not an owned agent — i.e. someone else is asking to join a channel
    // the caller administers.
    const isIncoming = !params.ownedActorIds.has(request.requesterAgentDbId);
    if (!isIncoming || request.status.tag !== 'Pending') {
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
  masumiRegistrationState?: { tag: string } | string | null;
};

export type OwnedInboxAgentEntry<Actor extends OwnedInboxActorLike> = {
  actor: Actor;
  managed: boolean;
  registered: boolean;
  deregistered: boolean;
};

export type ContactRequestLike = {
  id: bigint;
  requesterAgentDbId: bigint;
  requesterSlug: string;
  targetAgentDbId: bigint;
  targetSlug: string;
  status: { tag: string };
  updatedAt: TimestampLike;
};

export type ThreadInviteLike = {
  id: bigint;
  inviterAgentDbId: bigint;
  inviteeAgentDbId: bigint;
  status: { tag: string };
  updatedAt: TimestampLike;
};

export type ContactAllowlistEntryLike = {
  id: bigint;
  accountId: bigint;
  createdAt: TimestampLike;
};

export type SessionOwnedInboxLike = {
  id: bigint;
  email: string;
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
export type ChannelsTab = 'public' | 'mine';

export function parseAgentsTab(value: unknown): AgentsTab {
  return value === 'agents' || value === 'register' ? 'agents' : 'discover';
}

export function parseChannelsTab(value: unknown): ChannelsTab {
  return value === 'mine' ? 'mine' : 'public';
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
  return value === 'approvals' || value === 'settings' ? value : undefined;
}

export function findSessionOwnedInbox<Inbox extends SessionOwnedInboxLike>(params: {
  inboxes: Inbox[];
  session: BrowserSessionLike | null;
}): Inbox | null {
  const rawEmail = params.session?.user.email ?? null;
  if (!rawEmail) {
    return null;
  }

  const email = normalizeEmail(rawEmail);
  return (
    params.inboxes.find(inbox => {
      return (
        inbox.email === email &&
        inbox.authIssuer === params.session?.user.issuer &&
        inbox.authSubject === params.session?.user.subject
      );
    }) ?? null
  );
}

export function findDefaultOwnedActor<Actor extends ActorLike>(
  actors: Actor[],
  accountId: bigint | null
): Actor | null {
  if (accountId === null) {
    return null;
  }

  return actors.find(actor => actor.accountId === accountId && actor.isDefault) ?? null;
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
  email: string;
}): OwnedInboxAgentEntry<Actor>[] {
  return params.actors
    .filter(actor => {
      if (params.ownInboxId !== null) {
        return actor.accountId === params.ownInboxId;
      }

      return actor.email === params.email;
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
        deregistered: isDeregisteringOrDeregisteredMasumiRegistrationMetadata(metadata),
      };
    });
}

function readActorRegistrationMetadata(
  actor: OwnedInboxActorLike
): MasumiActorRegistrationMetadata | null {
  const stateRaw = actor.masumiRegistrationState;
  const stateString =
    typeof stateRaw === 'string' ? stateRaw : stateRaw?.tag ?? null;
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState:
      stateString && isMasumiInboxAgentState(stateString) ? stateString : undefined,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

export function resolveShellInboxSlug<Actor extends OwnedInboxActorLike>(
  ownedEntries: OwnedInboxAgentEntry<Actor>[],
  preferredSlug?: string | null
): string | null {
  const usableEntries = ownedEntries.filter(entry => !entry.deregistered);
  if (preferredSlug && usableEntries.some(entry => entry.actor.slug === preferredSlug)) {
    return preferredSlug;
  }

  return usableEntries[0]?.actor.slug ?? null;
}

function isUsableOwnedInboxAgent<Actor extends OwnedInboxActorLike>(
  entry: OwnedInboxAgentEntry<Actor> | undefined
): entry is OwnedInboxAgentEntry<Actor> {
  return Boolean(entry && !entry.deregistered);
}

function findUsableDefaultActor<Actor extends OwnedInboxActorLike>(
  ownedEntries: OwnedInboxAgentEntry<Actor>[],
  existingDefaultActor: Actor | null
): Actor | null {
  if (
    existingDefaultActor &&
    !isDeregisteringOrDeregisteredMasumiRegistrationMetadata(
      readActorRegistrationMetadata(existingDefaultActor)
    )
  ) {
    return existingDefaultActor;
  }

  return ownedEntries.find(entry => !entry.deregistered)?.actor ?? null;
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
  email: string;
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
  const email = normalizeEmail(params.session?.user.email ?? '');
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
    email,
  });
  const selectedEntry = params.selectedSlug
    ? ownedInboxAgents.find(entry => entry.actor.slug === params.selectedSlug)
    : undefined;
  const selectedActor = params.selectedSlug
    ? isUsableOwnedInboxAgent(selectedEntry)
      ? selectedEntry.actor
      : null
    : findUsableDefaultActor(ownedInboxAgents, existingDefaultActor);
  const shellInboxSlug = resolveShellInboxSlug(
    ownedInboxAgents,
    selectedActor?.slug ?? existingDefaultActor?.slug ?? null
  );
  const approvalView =
    params.selectedSlug && !selectedActor
      ? buildApprovalView({
          contactRequests: [],
          threadInvites: [],
          ownedActors: [],
        })
      : buildApprovalView({
          contactRequests: params.contactRequests,
          threadInvites: params.threadInvites ?? [],
          ownedActors: ownedInboxAgents.map(entry => entry.actor),
          selectedSlug: selectedActor?.slug,
        });

  return {
    email,
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
    params.normalizedSessionEmail !== params.inbox.email
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

  const incoming = relevantRequests.filter(request => ownedActorIds.has(request.targetAgentDbId));
  const outgoing = relevantRequests.filter(request => ownedActorIds.has(request.requesterAgentDbId));
  const ownedActorBySlug = new Map(
    params.ownedActors.map(actor => [actor.slug, actor.id])
  );
  const selectedActorId =
    selectedSlug !== null ? ownedActorBySlug.get(selectedSlug) ?? null : null;
  const relevantInvites = (params.threadInvites ?? [])
    .filter(invite => {
      return (
        ownedActorIds.has(invite.inviteeAgentDbId) ||
        ownedActorIds.has(invite.inviterAgentDbId)
      );
    })
    .filter(invite => {
      if (selectedActorId === null) {
        return true;
      }

      return (
        invite.inviteeAgentDbId === selectedActorId ||
        invite.inviterAgentDbId === selectedActorId
      );
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
      incoming.filter(request => request.status.tag === 'Pending').length +
      incomingThreadInvites.filter(invite => invite.status.tag === 'Pending').length,
    pendingOutgoingCount:
      outgoing.filter(request => request.status.tag === 'Pending').length +
      outgoingThreadInvites.filter(invite => invite.status.tag === 'Pending').length,
  };
}

export function filterAllowlistEntriesByInboxId<Entry extends ContactAllowlistEntryLike>(
  entries: Entry[],
  accountId: bigint | null
): Entry[] {
  if (accountId === null) {
    return [];
  }

  return entries
    .filter(entry => entry.accountId === accountId)
    .sort((left, right) => {
      const byCreatedAt = compareTimestampsDesc(left.createdAt, right.createdAt);
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }

      return Number(right.id - left.id);
    });
}
