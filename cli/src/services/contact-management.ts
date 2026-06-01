import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { timestampToISOString } from '../../../shared/spacetime-time';
import type {
  Agent,
  ContactRequest,
  ContactAllowlistEntry,
  ThreadInvite,
} from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { connectivityError, userError } from './errors';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import {
  connectAuthenticated,
  disconnectConnection,
  readContactRows,
  subscribeContactTables,
} from './spacetimedb';

function requireDefaultOwnedActor(
  actors: Agent[],
  email: string
): Agent {
  const actor = actors.find(row => row.isDefault && row.email === email);
  if (!actor) {
    throw userError(
      'No default agent found. Run `masumi-agent-messenger account sync` first, or `masumi-agent-messenger account sync --json` in automation.',
      {
        code: 'INBOX_BOOTSTRAP_REQUIRED',
        hint: 'masumi-agent-messenger account sync --json',
      }
    );
  }
  return actor;
}

function resolveOwnedActorBySlug(params: {
  actors: Agent[];
  email: string;
  actorSlug?: string;
}): Agent {
  const defaultActor = requireDefaultOwnedActor(params.actors, params.email);
  if (!params.actorSlug) {
    return defaultActor;
  }

  const normalizedSlug = normalizeInboxSlug(params.actorSlug);
  if (!normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const actor = params.actors.find(
    row => row.accountId === defaultActor.accountId && row.slug === normalizedSlug
  );
  if (!actor) {
    throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }
  return actor;
}

function resolveContactRequestTargetActor(params: {
  actors: Agent[];
  email: string;
  request: ContactRequest;
  actorSlug?: string;
}): Agent {
  if (params.actorSlug) {
    const actor = resolveOwnedActorBySlug({
      actors: params.actors,
      email: params.email,
      actorSlug: params.actorSlug,
    });
    if (params.request.targetAgentDbId !== actor.id) {
      throw userError('This request does not belong to the selected agent.', {
        code: 'CONTACT_REQUEST_TARGET_INVALID',
      });
    }
    return actor;
  }

  const defaultActor = requireDefaultOwnedActor(params.actors, params.email);
  const targetActor = params.actors.find(
    actor =>
      actor.accountId === defaultActor.accountId && actor.id === params.request.targetAgentDbId
  );
  if (!targetActor) {
    throw userError('This request does not belong to any owned agent in this inbox.', {
      code: 'CONTACT_REQUEST_TARGET_INVALID',
    });
  }

  return targetActor;
}

function resolveContactRequestRequesterActor(params: {
  actors: Agent[];
  email: string;
  request: ContactRequest;
  actorSlug?: string;
}): Agent {
  if (params.actorSlug) {
    const actor = resolveOwnedActorBySlug({
      actors: params.actors,
      email: params.email,
      actorSlug: params.actorSlug,
    });
    if (params.request.requesterAgentDbId !== actor.id) {
      throw userError('This request does not belong to the selected agent.', {
        code: 'CONTACT_REQUEST_REQUESTER_INVALID',
      });
    }
    return actor;
  }

  const defaultActor = requireDefaultOwnedActor(params.actors, params.email);
  const requesterActor = params.actors.find(
    actor =>
      actor.accountId === defaultActor.accountId && actor.id === params.request.requesterAgentDbId
  );
  if (!requesterActor) {
    throw userError('This request does not belong to any owned agent in this inbox.', {
      code: 'CONTACT_REQUEST_REQUESTER_INVALID',
    });
  }

  return requesterActor;
}

function parseRequestId(value: string): bigint {
  const normalizedValue = value.startsWith('#') ? value.slice(1) : value;
  try {
    const parsed = BigInt(normalizedValue);
    if (parsed < 1n) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw userError('Request id must be a positive integer.', {
      code: 'INVALID_REQUEST_ID',
    });
  }
}

function findRequestById(
  requests: ContactRequest[],
  requestId: bigint
): ContactRequest {
  const request = requests.find(row => row.id === requestId);
  if (!request) {
    throw userError(`Contact request ${requestId.toString()} is not visible.`, {
      code: 'CONTACT_REQUEST_NOT_FOUND',
    });
  }
  return request;
}

async function findCancelableContactRequestById(params: {
  requests: ContactRequest[];
  requestId: bigint;
  lookup: (input: { requestId: bigint }) => Promise<ContactRequest | undefined>;
}): Promise<ContactRequest> {
  const visibleRequest = params.requests.find(row => row.id === params.requestId);
  if (visibleRequest) {
    return visibleRequest;
  }

  const request = await params.lookup({ requestId: params.requestId });
  if (!request) {
    throw userError(`Contact request ${params.requestId.toString()} is not visible.`, {
      code: 'CONTACT_REQUEST_NOT_FOUND',
    });
  }
  return request;
}

function findThreadInviteById(
  invites: ThreadInvite[],
  inviteId: bigint
): ThreadInvite {
  const invite = invites.find(row => row.id === inviteId);
  if (!invite) {
    throw userError(`Thread invite ${inviteId.toString()} is not visible.`, {
      code: 'THREAD_INVITE_NOT_FOUND',
    });
  }
  return invite;
}

function enumTag(value: { tag: string } | string | null | undefined): string {
  if (typeof value === 'string') return value;
  return value?.tag ?? '';
}

function contactRequestStatus(
  status: ContactRequest['status'] | undefined
): ContactRequestListItem['status'] | null {
  const tag = enumTag(status);
  if (tag === 'Pending' || tag === 'pending') return 'pending';
  if (tag === 'Approved' || tag === 'approved') return 'approved';
  if (tag === 'Rejected' || tag === 'rejected') return 'rejected';
  return null;
}

function threadInviteStatus(
  status: ThreadInvite['status'] | undefined
): ThreadInviteListItem['status'] | null {
  const tag = enumTag(status);
  if (tag === 'Pending' || tag === 'pending') return 'pending';
  if (tag === 'Accepted' || tag === 'accepted') return 'accepted';
  if (tag === 'Declined' || tag === 'declined' || tag === 'rejected') return 'rejected';
  return null;
}

function allowlistKind(kind: ContactAllowlistEntry['kind']): 'agent' | 'email' {
  const tag = enumTag(kind);
  return tag === 'Agent' || tag === 'agent' ? 'agent' : 'email';
}

function contactRequestDirection(
  request: ContactRequest,
  ownedActorIds: ReadonlySet<bigint>
): 'incoming' | 'outgoing' | null {
  if (ownedActorIds.has(request.targetAgentDbId)) return 'incoming';
  if (ownedActorIds.has(request.requesterAgentDbId)) return 'outgoing';
  return null;
}

function actorLabel(actor: Agent | undefined, fallbackSlug: string): {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  email: string;
} {
  return {
    slug: actor?.slug ?? fallbackSlug,
    displayName: actor?.displayName ?? null,
    publicIdentity: actor?.publicIdentity ?? '',
    email: actor?.email ?? '',
  };
}

function waitForRequestStatus(params: {
  read: () => ReturnType<typeof readContactRows>;
  requestId: bigint;
  status: 'approved' | 'rejected';
  deletedFallback?: ContactRequest;
  timeoutMs?: number;
}): Promise<ContactRequest> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = async () => {
      const request = (await params.read()).contactRequests.find(row => row.id === params.requestId);
      if (request && contactRequestStatus(request.status) === params.status) {
        resolve(request);
        return;
      }
      if (!request && params.status === 'rejected' && params.deletedFallback) {
        resolve({
          ...params.deletedFallback,
          status: { tag: 'Rejected' },
        });
        return;
      }
      if (Date.now() >= timeoutAt) {
        reject(
          connectivityError('Timed out waiting for the contact request to update.', {
            code: 'CONTACT_REQUEST_SYNC_TIMEOUT',
          })
        );
        return;
      }
      setTimeout(() => {
        void poll().catch(reject);
      }, 100);
    };

    void poll().catch(reject);
  });
}

async function waitForContactRequestCancellation(params: {
  read: () => ReturnType<typeof readContactRows>;
  requestId: bigint;
  lookup: (input: { requestId: bigint }) => Promise<ContactRequest | undefined>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const visibleRequest = (await params.read()).contactRequests.find(row => row.id === params.requestId);
    const request = visibleRequest ?? (await params.lookup({ requestId: params.requestId }));
    if (!request) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw connectivityError('Timed out waiting for the contact request to be canceled.', {
    code: 'CONTACT_REQUEST_SYNC_TIMEOUT',
  });
}

function waitForThreadInviteStatus(params: {
  read: () => ReturnType<typeof readContactRows>;
  inviteId: bigint;
  status: 'accepted' | 'rejected';
  timeoutMs?: number;
}): Promise<ThreadInvite> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = async () => {
      const invite = (await params.read()).threadInvites.find(row => row.id === params.inviteId);
      if (invite && threadInviteStatus(invite.status) === params.status) {
        resolve(invite);
        return;
      }
      if (Date.now() >= timeoutAt) {
        reject(
          connectivityError('Timed out waiting for the thread invite to update.', {
            code: 'THREAD_INVITE_SYNC_TIMEOUT',
          })
        );
        return;
      }
      setTimeout(() => {
        void poll().catch(reject);
      }, 100);
    };

    void poll().catch(reject);
  });
}

function waitForAllowlistEntry(
  params: {
    read: () => ReturnType<typeof readContactRows>;
    matcher: (entry: ContactAllowlistEntry) => boolean;
    timeoutMs?: number;
  }
): Promise<ContactAllowlistEntry> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = async () => {
      const entry = (await params.read()).allowlistEntries.find(params.matcher);
      if (entry) {
        resolve(entry);
        return;
      }
      if (Date.now() >= timeoutAt) {
        reject(
          connectivityError('Timed out waiting for the allowlist change to sync.', {
            code: 'CONTACT_ALLOWLIST_SYNC_TIMEOUT',
          })
        );
        return;
      }
      setTimeout(() => {
        void poll().catch(reject);
      }, 100);
    };

    void poll().catch(reject);
  });
}

function waitForAllowlistRemoval(params: {
  read: () => ReturnType<typeof readContactRows>;
  entryId: bigint;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = async () => {
      const stillExists = (await params.read()).allowlistEntries.some(row => row.id === params.entryId);
      if (!stillExists) {
        resolve();
        return;
      }
      if (Date.now() >= timeoutAt) {
        reject(
          connectivityError('Timed out waiting for the allowlist removal to sync.', {
            code: 'CONTACT_ALLOWLIST_SYNC_TIMEOUT',
          })
        );
        return;
      }
      setTimeout(() => {
        void poll().catch(reject);
      }, 100);
    };

    void poll().catch(reject);
  });
}

export type ContactRequestListItem = {
  id: string;
  threadId: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'approved' | 'rejected';
  messageCount: string;
  requester: {
    slug: string;
    displayName: string | null;
    publicIdentity: string;
    email: string;
  };
  target: {
    slug: string;
    displayName: string | null;
    publicIdentity: string;
  };
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type ContactRequestListResult = {
  profile: string;
  total: number;
  requests: ContactRequestListItem[];
};

export type ThreadInviteListItem = {
  id: string;
  threadId: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'accepted' | 'rejected';
  inviter: {
    slug: string;
    displayName: string | null;
    publicIdentity: string;
  };
  invitee: {
    slug: string;
    displayName: string | null;
    publicIdentity: string;
  };
  threadTitle: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type ThreadInviteListResult = {
  profile: string;
  total: number;
  invites: ThreadInviteListItem[];
};

export async function listContactRequests(params: {
  profileName: string;
  reporter: TaskReporter;
  slug?: string;
  incoming?: boolean;
  outgoing?: boolean;
}): Promise<ContactRequestListResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const normalizedSlug = params.slug ? normalizeInboxSlug(params.slug) : null;
  if (params.slug && !normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const snapshot = await readContactRows(conn);
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, email);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.accountId === defaultActor.accountId)
          .map(actor => actor.id)
      );
      const actorById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
      const incomingOnly = Boolean(params.incoming && !params.outgoing);
      const outgoingOnly = Boolean(params.outgoing && !params.incoming);

      const requests = snapshot.contactRequests
        .map(request => {
          const direction = contactRequestDirection(request, ownedActorIds);
          return direction ? { request, direction } : null;
        })
        .filter((entry): entry is { request: ContactRequest; direction: 'incoming' | 'outgoing' } =>
          entry !== null
        )
        .filter(entry => (incomingOnly ? entry.direction === 'incoming' : true))
        .filter(entry => (outgoingOnly ? entry.direction === 'outgoing' : true))
        .filter(entry => {
          if (!normalizedSlug) return true;
          return entry.direction === 'incoming'
            ? entry.request.targetSlug === normalizedSlug
            : entry.request.requesterSlug === normalizedSlug;
        })
        .sort((left, right) => {
          return (
            Number(
              right.request.updatedAt.microsSinceUnixEpoch -
                left.request.updatedAt.microsSinceUnixEpoch
            ) || Number(right.request.id - left.request.id)
          );
        })
        .map(entry => {
          const requester = actorLabel(
            actorById.get(entry.request.requesterAgentDbId),
            entry.request.requesterSlug
          );
          const target = actorLabel(
            actorById.get(entry.request.targetAgentDbId),
            entry.request.targetSlug
          );
          return {
            id: entry.request.id.toString(),
            threadId: entry.request.threadId.toString(),
            direction: entry.direction,
            status: contactRequestStatus(entry.request.status) ?? 'pending',
            messageCount: '0',
            requester: {
              ...requester,
              publicIdentity: entry.request.requesterPublicIdentity,
            },
            target: {
              slug: target.slug,
              displayName: target.displayName,
              publicIdentity: entry.request.targetPublicIdentity,
            },
            createdAt: timestampToISOString(entry.request.createdAt),
            updatedAt: timestampToISOString(entry.request.updatedAt),
            resolvedAt: entry.request.resolvedAt
              ? timestampToISOString(entry.request.resolvedAt)
              : null,
          } satisfies ContactRequestListItem;
        });

      return {
        profile: profile.name,
        total: requests.length,
        requests,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function listThreadInvites(params: {
  profileName: string;
  reporter: TaskReporter;
  slug?: string;
  incoming?: boolean;
  outgoing?: boolean;
}): Promise<ThreadInviteListResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const normalizedSlug = params.slug ? normalizeInboxSlug(params.slug) : null;
  if (params.slug && !normalizedSlug) {
    throw userError('Inbox slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const snapshot = await readContactRows(conn);
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, email);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.accountId === defaultActor.accountId)
          .map(actor => actor.id)
      );
      const actorById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));
      const incomingOnly = Boolean(params.incoming && !params.outgoing);
      const outgoingOnly = Boolean(params.outgoing && !params.incoming);

      const invites = snapshot.threadInvites
        .map(invite => {
          const direction = ownedActorIds.has(invite.inviteeAgentDbId)
            ? 'incoming'
            : ownedActorIds.has(invite.inviterAgentDbId)
              ? 'outgoing'
              : null;
          return direction ? { invite, direction } : null;
        })
        .filter((entry): entry is { invite: ThreadInvite; direction: 'incoming' | 'outgoing' } =>
          entry !== null
        )
        .filter(entry => (incomingOnly ? entry.direction === 'incoming' : true))
        .filter(entry => (outgoingOnly ? entry.direction === 'outgoing' : true))
        .filter(entry => {
          if (!normalizedSlug) return true;
          const inviteeSlug = actorById.get(entry.invite.inviteeAgentDbId)?.slug;
          const inviterSlug = actorById.get(entry.invite.inviterAgentDbId)?.slug;
          return entry.direction === 'incoming'
            ? inviteeSlug === normalizedSlug
            : inviterSlug === normalizedSlug;
        })
        .sort((left, right) => {
          return (
            Number(
              right.invite.updatedAt.microsSinceUnixEpoch -
                left.invite.updatedAt.microsSinceUnixEpoch
            ) || Number(right.invite.id - left.invite.id)
          );
        })
        .map(entry => {
          const inviter = actorLabel(
            actorById.get(entry.invite.inviterAgentDbId),
            `agent:${entry.invite.inviterAgentDbId.toString()}`
          );
          const invitee = actorLabel(
            actorById.get(entry.invite.inviteeAgentDbId),
            `agent:${entry.invite.inviteeAgentDbId.toString()}`
          );
          return {
            id: entry.invite.id.toString(),
            threadId: entry.invite.threadId.toString(),
            direction: entry.direction,
            status: threadInviteStatus(entry.invite.status) ?? 'pending',
            inviter: {
              slug: inviter.slug,
              displayName: inviter.displayName,
              publicIdentity: inviter.publicIdentity,
            },
            invitee: {
              slug: invitee.slug,
              displayName: invitee.displayName,
              publicIdentity: invitee.publicIdentity,
            },
            threadTitle: `Thread #${entry.invite.threadId.toString()}`,
            createdAt: timestampToISOString(entry.invite.createdAt),
            updatedAt: timestampToISOString(entry.invite.updatedAt),
            resolvedAt: entry.invite.resolvedAt
              ? timestampToISOString(entry.invite.resolvedAt)
              : null,
          } satisfies ThreadInviteListItem;
        });

      return {
        profile: profile.name,
        total: invites.length,
        invites,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function resolveContactRequest(params: {
  profileName: string;
  reporter: TaskReporter;
  requestId: string;
  action: 'approve' | 'reject';
  actorSlug?: string;
}): Promise<{
  profile: string;
  requestId: string;
  status: 'approved' | 'rejected';
  slug: string;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const parsedRequestId = parseRequestId(params.requestId);
  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const request = findRequestById(snapshot.contactRequests, parsedRequestId);
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, email);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.accountId === defaultActor.accountId)
          .map(actor => actor.id)
      );
      if (contactRequestDirection(request, ownedActorIds) !== 'incoming') {
        throw userError('Only incoming contact requests can be resolved from this inbox.', {
          code: 'CONTACT_REQUEST_DIRECTION_INVALID',
        });
      }
      const selectedActor = resolveContactRequestTargetActor({
        actors: snapshot.actors,
        email,
        request,
        actorSlug: params.actorSlug,
      });

      if (params.action === 'approve') {
        await conn.reducers.approveContactRequest({
          agentDbId: selectedActor.id,
          requestId: parsedRequestId,
        });
      } else {
        await conn.reducers.rejectContactRequest({
          agentDbId: selectedActor.id,
          requestId: parsedRequestId,
        });
      }

      const resolved = await waitForRequestStatus({
        read,
        requestId: parsedRequestId,
        status: params.action === 'approve' ? 'approved' : 'rejected',
        deletedFallback: params.action === 'reject' ? request : undefined,
      });

      return {
        profile: profile.name,
        requestId: resolved.id.toString(),
        status: (contactRequestStatus(resolved.status) ?? 'rejected') as 'approved' | 'rejected',
        slug: resolved.targetSlug,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function cancelContactRequest(params: {
  profileName: string;
  reporter: TaskReporter;
  requestId: string;
  actorSlug?: string;
}): Promise<{
  profile: string;
  requestId: string;
  status: 'canceled';
  slug: string;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const parsedRequestId = parseRequestId(params.requestId);
  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const lookupContactRequest = async (input: { requestId: bigint }) => {
        const rows = await conn.procedures.readContactRequest(input);
        return rows[0];
      };
      const request = await findCancelableContactRequestById({
        requests: snapshot.contactRequests,
        requestId: parsedRequestId,
        lookup: lookupContactRequest,
      });
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, email);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.accountId === defaultActor.accountId)
          .map(actor => actor.id)
      );
      if (contactRequestDirection(request, ownedActorIds) !== 'outgoing') {
        throw userError('Only outgoing contact requests can be canceled from this inbox.', {
          code: 'CONTACT_REQUEST_DIRECTION_INVALID',
        });
      }
      const selectedActor = resolveContactRequestRequesterActor({
        actors: snapshot.actors,
        email,
        request,
        actorSlug: params.actorSlug,
      });

      await conn.reducers.cancelContactRequest({
        agentDbId: selectedActor.id,
        requestId: parsedRequestId,
      });
      await waitForContactRequestCancellation({
        read,
        requestId: parsedRequestId,
        lookup: lookupContactRequest,
      });

      return {
        profile: profile.name,
        requestId: request.id.toString(),
        status: 'canceled',
        slug: request.targetSlug,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function resolveThreadInvite(params: {
  profileName: string;
  reporter: TaskReporter;
  inviteId: string;
  action: 'accept' | 'reject';
  actorSlug?: string;
}): Promise<{
  profile: string;
  inviteId: string;
  status: 'accepted' | 'rejected';
  slug: string;
  threadId: string;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const parsedInviteId = parseRequestId(params.inviteId);
  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const selectedActor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            email,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, email);
      const invite = findThreadInviteById(snapshot.threadInvites, parsedInviteId);
      if (invite.inviteeAgentDbId !== selectedActor.id) {
        throw userError('Only incoming thread invites can be resolved from this agent.', {
          code: 'THREAD_INVITE_INVITEE_INVALID',
        });
      }

      if (params.action === 'accept') {
        await conn.reducers.acceptThreadInvite({
          agentDbId: invite.inviteeAgentDbId,
          inviteId: parsedInviteId,
        });
      } else {
        await conn.reducers.declineThreadInvite({
          agentDbId: invite.inviteeAgentDbId,
          inviteId: parsedInviteId,
        });
      }

      const resolved = await waitForThreadInviteStatus({
        read,
        inviteId: parsedInviteId,
        status: params.action === 'accept' ? 'accepted' : 'rejected',
      });

      return {
        profile: profile.name,
        inviteId: resolved.id.toString(),
        status: (threadInviteStatus(resolved.status) ?? 'rejected') as 'accepted' | 'rejected',
        slug:
          snapshot.actors.find(actor => actor.id === resolved.inviteeAgentDbId)?.slug ??
          `agent:${resolved.inviteeAgentDbId.toString()}`,
        threadId: resolved.threadId.toString(),
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export type ContactAllowlistListResult = {
  profile: string;
  total: number;
  entries: Array<{
    id: string;
    kind: 'agent' | 'email';
    value: string;
    label: string | null;
    createdAt: string;
  }>;
};

export async function listContactAllowlist(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
}): Promise<ContactAllowlistListResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const snapshot = await readContactRows(conn);
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            email,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, email);
      const entries = snapshot.allowlistEntries
        .filter(entry => entry.accountId === actor.accountId)
        .sort((left, right) => Number(right.createdAt.microsSinceUnixEpoch - left.createdAt.microsSinceUnixEpoch))
        .map(entry => {
          const kind = allowlistKind(entry.kind);
          return {
            id: entry.id.toString(),
            kind,
            value:
              kind === 'agent'
                ? (entry.agentPublicIdentity ?? '')
                : (entry.email ?? ''),
            label: kind === 'agent' ? entry.agentSlug ?? null : entry.email ?? null,
            createdAt: timestampToISOString(entry.createdAt),
          };
        });

      return {
        profile: profile.name,
        total: entries.length,
        entries,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function addContactAllowlist(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
  agent?: string;
  email?: string;
}): Promise<{
  profile: string;
  entryId: string;
  kind: 'agent' | 'email';
  value: string;
}> {
  if (Boolean(params.agent) === Boolean(params.email)) {
    throw userError('Choose either `--agent` or `--email`.', {
      code: 'CONTACT_ALLOWLIST_INPUT_INVALID',
    });
  }

  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            email,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, email);

      if (params.agent) {
        const resolved = await resolvePublishedActorLookup({
          identifier: params.agent,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input =>
            conn.procedures.lookupPublishedAgentsByEmailPage({
              ...input,
              afterId: undefined,
              limit: undefined,
            }),
          invalidMessage: 'Inbox slug is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to resolve inbox slug.',
        });
        const publicIdentity = resolved.selected.publicIdentity;
        await conn.reducers.addContactAllowlistEntry({
          agentDbId: actor.id,
          kind: { tag: 'Agent' },
          agentPublicIdentity: publicIdentity,
          email: undefined,
        });
        const entry = await waitForAllowlistEntry({
          read,
          matcher: row =>
            allowlistKind(row.kind) === 'agent' && row.agentPublicIdentity === publicIdentity,
        });
        return {
          profile: profile.name,
          entryId: entry.id.toString(),
          kind: 'agent',
          value: entry.agentPublicIdentity ?? '',
        };
      }

      const normalizedTargetEmail = requireNonEmptyEmail(params.email);
      await conn.reducers.addContactAllowlistEntry({
        agentDbId: actor.id,
        kind: { tag: 'Email' },
        agentPublicIdentity: undefined,
        email: normalizedTargetEmail,
      });
      const entry = await waitForAllowlistEntry({
        read,
        matcher: row => allowlistKind(row.kind) === 'email' && row.email === normalizedTargetEmail,
      });
      return {
        profile: profile.name,
        entryId: entry.id.toString(),
        kind: 'email',
        value: entry.email ?? normalizedTargetEmail,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

function requireNonEmptyEmail(value: string | undefined): string {
  const normalized = normalizeEmail(value ?? '');
  if (!normalized) {
    throw userError('Email is required.', {
      code: 'INVALID_EMAIL',
    });
  }
  return normalized;
}

export async function removeContactAllowlist(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
  agent?: string;
  email?: string;
}): Promise<{
  profile: string;
  removed: boolean;
  kind: 'agent' | 'email';
  value: string;
}> {
  if (Boolean(params.agent) === Boolean(params.email)) {
    throw userError('Choose either `--agent` or `--email`.', {
      code: 'CONTACT_ALLOWLIST_INPUT_INVALID',
    });
  }

  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            email,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, email);

      if (params.agent) {
        const resolved = await resolvePublishedActorLookup({
          identifier: params.agent,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input =>
            conn.procedures.lookupPublishedAgentsByEmailPage({
              ...input,
              afterId: undefined,
              limit: undefined,
            }),
          invalidMessage: 'Inbox slug is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to resolve inbox slug.',
        });
        const entry = snapshot.allowlistEntries.find(
          row =>
            row.accountId === actor.accountId &&
            allowlistKind(row.kind) === 'agent' &&
            row.agentPublicIdentity === resolved.selected.publicIdentity
        );
        if (!entry) {
          throw userError('That agent is not in the agent allowlist.', {
            code: 'CONTACT_ALLOWLIST_ENTRY_NOT_FOUND',
          });
        }

        await conn.reducers.removeContactAllowlistEntry({
          entryId: entry.id,
        });
        await waitForAllowlistRemoval({ read, entryId: entry.id });
        return {
          profile: profile.name,
          removed: true,
          kind: 'agent',
          value: entry.agentPublicIdentity ?? '',
        };
      }

      const normalizedTargetEmail = requireNonEmptyEmail(params.email);
      const entry = snapshot.allowlistEntries.find(
        row =>
          row.accountId === actor.accountId &&
          allowlistKind(row.kind) === 'email' &&
          row.email === normalizedTargetEmail
      );
      if (!entry) {
        throw userError('That email is not in the agent allowlist.', {
          code: 'CONTACT_ALLOWLIST_ENTRY_NOT_FOUND',
        });
      }

      await conn.reducers.removeContactAllowlistEntry({
        entryId: entry.id,
      });
      await waitForAllowlistRemoval({ read, entryId: entry.id });
      return {
        profile: profile.name,
        removed: true,
        kind: 'email',
        value: entry.email ?? normalizedTargetEmail,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function setPublicDescription(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
  description?: string;
}): Promise<{
  profile: string;
  slug: string;
  description: string | null;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        email,
        actorSlug: params.actorSlug,
      });
      const normalizedDescription = params.description?.trim() || undefined;

      await conn.reducers.updateAgentProfile({
        agentDbId: actor.id,
        displayName: undefined,
        publicDescription: normalizedDescription,
        publicLinkedEmailEnabled: undefined,
        allowAllMessageContentTypes: undefined,
        allowAllMessageHeaders: undefined,
        supportedMessageContentTypes: undefined,
        supportedMessageHeaderNames: undefined,
      });

      const updatedActor = await new Promise<Agent>((resolve, reject) => {
        const timeoutAt = Date.now() + 10000;
        const poll = async () => {
          const nextActor = (await read()).actors.find(row => row.id === actor.id);
          if (nextActor && (nextActor.publicDescription ?? null) === (normalizedDescription ?? null)) {
            resolve(nextActor);
            return;
          }
          if (Date.now() >= timeoutAt) {
            reject(
              connectivityError('Timed out waiting for the public description to sync.', {
                code: 'PUBLIC_DESCRIPTION_SYNC_TIMEOUT',
              })
            );
            return;
          }
          setTimeout(() => {
            void poll().catch(reject);
          }, 100);
        };
        void poll().catch(reject);
      });

      return {
        profile: profile.name,
        slug: updatedActor.slug,
        description: updatedActor.publicDescription ?? null,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function setPublicLinkedEmailVisibility(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
  enabled: boolean;
}): Promise<{
  profile: string;
  slug: string;
  enabled: boolean;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const read = () => readContactRows(conn);
      const snapshot = await read();
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        email,
        actorSlug: params.actorSlug,
      });

      await conn.reducers.updateAgentProfile({
        agentDbId: actor.id,
        displayName: undefined,
        publicDescription: undefined,
        publicLinkedEmailEnabled: params.enabled,
        allowAllMessageContentTypes: undefined,
        allowAllMessageHeaders: undefined,
        supportedMessageContentTypes: undefined,
        supportedMessageHeaderNames: undefined,
      });

      const updatedActor = await new Promise<Agent>((resolve, reject) => {
        const timeoutAt = Date.now() + 10000;
        const poll = async () => {
          const nextActor = (await read()).actors.find(row => row.id === actor.id);
          if (nextActor && nextActor.publicLinkedEmailEnabled === params.enabled) {
            resolve(nextActor);
            return;
          }
          if (Date.now() >= timeoutAt) {
            reject(
              connectivityError('Timed out waiting for linked email visibility to sync.', {
                code: 'PUBLIC_LINKED_EMAIL_SYNC_TIMEOUT',
              })
            );
            return;
          }
          setTimeout(() => {
            void poll().catch(reject);
          }, 100);
        };
        void poll().catch(reject);
      });

      return {
        profile: profile.name,
        slug: updatedActor.slug,
        enabled: updatedActor.publicLinkedEmailEnabled,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function getPublicDescription(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string;
}): Promise<{
  profile: string;
  slug: string;
  description: string | null;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeContactTables(conn);
    try {
      const snapshot = await readContactRows(conn);
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        email,
        actorSlug: params.actorSlug,
      });

      return {
        profile: profile.name,
        slug: actor.slug,
        description: actor.publicDescription ?? null,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}
