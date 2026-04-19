import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { timestampToISOString } from '../../../shared/spacetime-time';
import type {
  VisibleAgentRow,
  VisibleContactRequestRow,
  VisibleContactAllowlistEntryRow,
  VisibleThreadInviteRow,
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
  actors: VisibleAgentRow[],
  normalizedEmail: string
): VisibleAgentRow {
  const actor = actors.find(row => row.isDefault && row.normalizedEmail === normalizedEmail);
  if (!actor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }
  return actor;
}

function resolveOwnedActorBySlug(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
  actorSlug?: string;
}): VisibleAgentRow {
  const defaultActor = requireDefaultOwnedActor(params.actors, params.normalizedEmail);
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
    row => row.inboxId === defaultActor.inboxId && row.slug === normalizedSlug
  );
  if (!actor) {
    throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }
  return actor;
}

function parseRequestId(value: string): bigint {
  try {
    const parsed = BigInt(value);
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
  requests: VisibleContactRequestRow[],
  requestId: bigint
): VisibleContactRequestRow {
  const request = requests.find(row => row.id === requestId);
  if (!request) {
    throw userError(`Contact request ${requestId.toString()} is not visible.`, {
      code: 'CONTACT_REQUEST_NOT_FOUND',
    });
  }
  return request;
}

function findThreadInviteById(
  invites: VisibleThreadInviteRow[],
  inviteId: bigint
): VisibleThreadInviteRow {
  const invite = invites.find(row => row.id === inviteId);
  if (!invite) {
    throw userError(`Thread invite ${inviteId.toString()} is not visible.`, {
      code: 'THREAD_INVITE_NOT_FOUND',
    });
  }
  return invite;
}

function waitForRequestStatus(params: {
  read: () => ReturnType<typeof readContactRows>;
  requestId: bigint;
  status: 'approved' | 'rejected';
  deletedFallback?: VisibleContactRequestRow;
  timeoutMs?: number;
}): Promise<VisibleContactRequestRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = params.read().contactRequests.find(row => row.id === params.requestId);
      if (request?.status === params.status) {
        resolve(request);
        return;
      }
      if (!request && params.status === 'rejected' && params.deletedFallback) {
        resolve({
          ...params.deletedFallback,
          status: 'rejected',
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
      setTimeout(poll, 100);
    };

    poll();
  });
}

function waitForThreadInviteStatus(params: {
  read: () => ReturnType<typeof readContactRows>;
  inviteId: bigint;
  status: 'accepted' | 'rejected';
  timeoutMs?: number;
}): Promise<VisibleThreadInviteRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = () => {
      const invite = params.read().threadInvites.find(row => row.id === params.inviteId);
      if (invite?.status === params.status) {
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
      setTimeout(poll, 100);
    };

    poll();
  });
}

function waitForAllowlistEntry(
  params: {
    read: () => ReturnType<typeof readContactRows>;
    matcher: (entry: VisibleContactAllowlistEntryRow) => boolean;
    timeoutMs?: number;
  }
): Promise<VisibleContactAllowlistEntryRow> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = () => {
      const entry = params.read().allowlistEntries.find(params.matcher);
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
      setTimeout(poll, 100);
    };

    poll();
  });
}

function waitForAllowlistRemoval(params: {
  read: () => ReturnType<typeof readContactRows>;
  entryId: bigint;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  return new Promise((resolve, reject) => {
    const poll = () => {
      const stillExists = params.read().allowlistEntries.some(row => row.id === params.entryId);
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
      setTimeout(poll, 100);
    };

    poll();
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = readContactRows(conn);
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, normalizedEmail);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.inboxId === defaultActor.inboxId)
          .map(actor => actor.id)
      );
      const incomingOnly = Boolean(params.incoming && !params.outgoing);
      const outgoingOnly = Boolean(params.outgoing && !params.incoming);

      const requests = snapshot.contactRequests
        .filter(request =>
          request.direction === 'incoming'
            ? ownedActorIds.has(request.targetAgentDbId)
            : ownedActorIds.has(request.requesterAgentDbId)
        )
        .filter(request => (incomingOnly ? request.direction === 'incoming' : true))
        .filter(request => (outgoingOnly ? request.direction === 'outgoing' : true))
        .filter(request => {
          if (!normalizedSlug) return true;
          return request.direction === 'incoming'
            ? request.targetSlug === normalizedSlug
            : request.requesterSlug === normalizedSlug;
        })
        .sort((left, right) => {
          return (
            Number(right.updatedAt.microsSinceUnixEpoch - left.updatedAt.microsSinceUnixEpoch) ||
            Number(right.id - left.id)
          );
        })
        .map(
          request =>
            ({
              id: request.id.toString(),
              threadId: request.threadId.toString(),
              direction: request.direction as ContactRequestListItem['direction'],
              status: request.status as ContactRequestListItem['status'],
              messageCount: request.messageCount.toString(),
              requester: {
                slug: request.requesterSlug,
                displayName: request.requesterDisplayName ?? null,
                publicIdentity: request.requesterPublicIdentity,
                email: request.requesterDisplayEmail,
              },
              target: {
                slug: request.targetSlug,
                displayName: request.targetDisplayName ?? null,
                publicIdentity: request.targetPublicIdentity,
              },
              createdAt: timestampToISOString(request.createdAt),
              updatedAt: timestampToISOString(request.updatedAt),
              resolvedAt: request.resolvedAt ? timestampToISOString(request.resolvedAt) : null,
            }) satisfies ContactRequestListItem
        );

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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = readContactRows(conn);
      const defaultActor = requireDefaultOwnedActor(snapshot.actors, normalizedEmail);
      const ownedActorIds = new Set(
        snapshot.actors
          .filter(actor => actor.inboxId === defaultActor.inboxId)
          .map(actor => actor.id)
      );
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
        .filter((entry): entry is { invite: VisibleThreadInviteRow; direction: 'incoming' | 'outgoing' } =>
          entry !== null
        )
        .filter(entry => (incomingOnly ? entry.direction === 'incoming' : true))
        .filter(entry => (outgoingOnly ? entry.direction === 'outgoing' : true))
        .filter(entry => {
          if (!normalizedSlug) return true;
          return entry.direction === 'incoming'
            ? entry.invite.inviteeSlug === normalizedSlug
            : entry.invite.inviterSlug === normalizedSlug;
        })
        .sort((left, right) => {
          return (
            Number(
              right.invite.updatedAt.microsSinceUnixEpoch -
                left.invite.updatedAt.microsSinceUnixEpoch
            ) || Number(right.invite.id - left.invite.id)
          );
        })
        .map(
          entry =>
            ({
              id: entry.invite.id.toString(),
              threadId: entry.invite.threadId.toString(),
              direction: entry.direction,
              status: entry.invite.status as ThreadInviteListItem['status'],
              inviter: {
                slug: entry.invite.inviterSlug,
                displayName: entry.invite.inviterDisplayName ?? null,
                publicIdentity: entry.invite.inviterPublicIdentity,
              },
              invitee: {
                slug: entry.invite.inviteeSlug,
                displayName: entry.invite.inviteeDisplayName ?? null,
                publicIdentity: entry.invite.inviteePublicIdentity,
              },
              threadTitle: entry.invite.threadTitle ?? null,
              createdAt: timestampToISOString(entry.invite.createdAt),
              updatedAt: timestampToISOString(entry.invite.updatedAt),
              resolvedAt: entry.invite.resolvedAt
                ? timestampToISOString(entry.invite.resolvedAt)
                : null,
            }) satisfies ThreadInviteListItem
        );

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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const selectedActor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            normalizedEmail,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, normalizedEmail);
      const request = findRequestById(snapshot.contactRequests, parsedRequestId);
      if (request.direction !== 'incoming') {
        throw userError('Only incoming contact requests can be resolved from this inbox.', {
          code: 'CONTACT_REQUEST_DIRECTION_INVALID',
        });
      }
      if (request.targetAgentDbId !== selectedActor.id) {
        throw userError('This request does not belong to the selected agent.', {
          code: 'CONTACT_REQUEST_TARGET_INVALID',
        });
      }

      if (params.action === 'approve') {
        await conn.reducers.approveContactRequest({
          agentDbId: request.targetAgentDbId,
          requestId: parsedRequestId,
        });
      } else {
        await conn.reducers.rejectContactRequest({
          agentDbId: request.targetAgentDbId,
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
        status: resolved.status as 'approved' | 'rejected',
        slug: resolved.targetSlug,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const selectedActor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            normalizedEmail,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, normalizedEmail);
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
        await conn.reducers.rejectThreadInvite({
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
        status: resolved.status as 'accepted' | 'rejected',
        slug: resolved.inviteeSlug,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = readContactRows(conn);
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            normalizedEmail,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, normalizedEmail);
      const entries = snapshot.allowlistEntries
        .filter(entry => entry.inboxId === actor.inboxId)
        .sort((left, right) => Number(right.createdAt.microsSinceUnixEpoch - left.createdAt.microsSinceUnixEpoch))
        .map(entry => ({
          id: entry.id.toString(),
          kind: entry.kind as 'agent' | 'email',
          value:
            entry.kind === 'agent'
              ? (entry.agentPublicIdentity ?? '')
              : (entry.displayEmail ?? entry.normalizedEmail ?? ''),
          label:
            entry.kind === 'agent'
              ? entry.agentDisplayName ?? entry.agentSlug ?? null
              : entry.displayEmail ?? null,
          createdAt: timestampToISOString(entry.createdAt),
        }));

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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            normalizedEmail,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, normalizedEmail);

      if (params.agent) {
        const resolved = await resolvePublishedActorLookup({
          identifier: params.agent,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
          invalidMessage: 'Inbox slug is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to resolve inbox slug.',
        });
        const publicIdentity = resolved.selected.publicIdentity;
        await conn.reducers.addContactAllowlistEntry({
          agentDbId: actor.id,
          agentPublicIdentity: publicIdentity,
          email: undefined,
        });
        const entry = await waitForAllowlistEntry({
          read,
          matcher: row => row.kind === 'agent' && row.agentPublicIdentity === publicIdentity,
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
        agentPublicIdentity: undefined,
        email: normalizedTargetEmail,
      });
      const entry = await waitForAllowlistEntry({
        read,
        matcher: row => row.kind === 'email' && row.normalizedEmail === normalizedTargetEmail,
      });
      return {
        profile: profile.name,
        entryId: entry.id.toString(),
        kind: 'email',
        value: entry.displayEmail ?? entry.normalizedEmail ?? normalizedTargetEmail,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const actor = params.actorSlug
        ? resolveOwnedActorBySlug({
            actors: snapshot.actors,
            normalizedEmail,
            actorSlug: params.actorSlug,
          })
        : requireDefaultOwnedActor(snapshot.actors, normalizedEmail);

      if (params.agent) {
        const resolved = await resolvePublishedActorLookup({
          identifier: params.agent,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
          invalidMessage: 'Inbox slug is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to resolve inbox slug.',
        });
        const entry = snapshot.allowlistEntries.find(
          row => row.kind === 'agent' && row.agentPublicIdentity === resolved.selected.publicIdentity
        );
        if (!entry) {
          throw userError('That agent is not in the inbox allowlist.', {
            code: 'CONTACT_ALLOWLIST_ENTRY_NOT_FOUND',
          });
        }

        await conn.reducers.removeContactAllowlistEntry({
          agentDbId: actor.id,
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
        row => row.kind === 'email' && row.normalizedEmail === normalizedTargetEmail
      );
      if (!entry) {
        throw userError('That email is not in the inbox allowlist.', {
          code: 'CONTACT_ALLOWLIST_ENTRY_NOT_FOUND',
        });
      }

      await conn.reducers.removeContactAllowlistEntry({
        agentDbId: actor.id,
        entryId: entry.id,
      });
      await waitForAllowlistRemoval({ read, entryId: entry.id });
      return {
        profile: profile.name,
        removed: true,
        kind: 'email',
        value: entry.displayEmail ?? entry.normalizedEmail ?? normalizedTargetEmail,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const normalizedDescription = params.description?.trim() || undefined;

      await conn.reducers.setAgentPublicDescription({
        agentDbId: actor.id,
        description: normalizedDescription,
      });

      const updatedActor = await new Promise<VisibleAgentRow>((resolve, reject) => {
        const timeoutAt = Date.now() + 10000;
        const poll = () => {
          const nextActor = read().actors.find(row => row.id === actor.id);
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
          setTimeout(poll, 100);
        };
        poll();
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = read();
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });

      await conn.reducers.setAgentPublicLinkedEmailVisibility({
        agentDbId: actor.id,
        enabled: params.enabled,
      });

      const updatedActor = await new Promise<VisibleAgentRow>((resolve, reject) => {
        const timeoutAt = Date.now() + 10000;
        const poll = () => {
          const nextActor = read().actors.find(row => row.id === actor.id);
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
          setTimeout(poll, 100);
        };
        poll();
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
      const snapshot = readContactRows(conn);
      const actor = resolveOwnedActorBySlug({
        actors: snapshot.actors,
        normalizedEmail,
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
