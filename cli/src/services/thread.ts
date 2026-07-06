import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findActorIdByPublicIdentity,
  findDefaultActorByEmail,
  isDirectThreadBetween,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  type PublishedActorIdentifierInputKind,
  type ResolvedPublishedActor,
} from '../../../shared/published-actors';
import { timestampToISOString } from '../../../shared/spacetime-time';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import type {
  Agent,
  ThreadParticipantPreview,
  Thread,
  ThreadInvite,
  ContactRequest,
  Message,
  ThreadSecretEnvelope as VisibleThreadSecretEnvelopeRow,
} from '../../../webapp/src/module_bindings/types';
import type {
  ListThreadMessagesPage as VisibleThreadMessagePage,
} from '../../../webapp/src/lib/procedures';
import { ensureAuthenticatedSession } from './auth';
import { getStoredActorKeyPairs } from './actor-keys';
import type { TaskReporter } from './command-runtime';
import {
  connectivityError,
  inboxBootstrapRequiredError,
  isCliError,
  userError,
} from './errors';
import { createSecretStore } from './secret-store';
import {
  buildPublicKeysByActorId,
  decryptVisibleMessage,
  lookupMessagePublicKeys,
} from './messages';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import {
  connectAuthenticated,
  disconnectConnection,
  readAllThreadParticipants,
  readLatestMetadataRows,
  type VisibleThreadReadStateRow,
} from './spacetimedb';
import { mergeRowsById } from './row-utils';
import type { EncryptedMessageHeader } from '../../../shared/message-format';

type MessageSnapshot = {
  actors: Agent[];
  participants: ThreadParticipantPreview[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: Thread[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  messages: Message[];
};
type VisibleThreadPage = {
  actors: Agent[];
  participantPreviews: ThreadParticipantPreview[];
  readStates: VisibleThreadReadStateRow[];
  threads: Thread[];
  nextAfterSortKey?: string | null;
};
type GeneratedVisibleThreadPage = Awaited<
  ReturnType<DbConnection['procedures']['listVisibleThreads']>
>;
type ThreadListFilter = 'active' | 'latest' | 'archived' | 'all';

export type ActorLookupMetadata = {
  input: string;
  inputKind: PublishedActorIdentifierInputKind;
  matchedActors: ResolvedPublishedActor[];
  selected: ResolvedPublishedActor;
};

export type ThreadListItem = {
  id: string;
  kind: string;
  label: string;
  locked: boolean;
  archived: boolean;
  unreadMessages: number;
  participantCount: number;
  participants: string[];
  lastMessageAt: string;
  lastMessageId: string;
};

export type ThreadListResult = {
  authenticated: true;
  connected: true;
  profile: string;
  actorSlug: string;
  includeArchived: boolean;
  filter: ThreadListFilter;
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  nextAfterSortKey: string | null;
  totalThreads: number;
  threads: ThreadListItem[];
};

export type ThreadHistoryMessage = {
  id: string;
  messageId: string;
  secretVersion: string;
  createdAt: string;
  sender: {
    id: string;
    slug: string;
    displayName: string | null;
    publicIdentity: string;
  };
  text: string | null;
  decryptStatus: 'ok' | 'unsupported' | 'failed';
  decryptError: string | null;
  contentType: string | null;
  headerNames: string[];
  headers: EncryptedMessageHeader[] | null;
  unsupportedReasons: string[];
  legacyPlaintext: boolean;
  replyToMessageId: string | null;
  trustStatus: 'self' | 'trusted' | 'unpinned-first-seen' | 'untrusted-rotation';
  trustNotice: string | null;
  trustWarning: string | null;
};

export type ThreadHistoryResult = {
  authenticated: true;
  connected: true;
  profile: string;
  actorSlug: string;
  thread: {
    id: string;
    kind: string;
    label: string;
    locked: boolean;
    archived: boolean;
  };
  lastReadMessageId: string;
  totalMessages: number;
  messages: ThreadHistoryMessage[];
};

export type ThreadMessageCountResult = {
  authenticated: true;
  connected: true;
  profile: string;
  actorSlug: string;
  thread: {
    id: string;
    kind: string;
    label: string;
    locked: boolean;
    archived: boolean;
    participantCount: number;
    participants: string[];
  };
  messageCount: number;
  lastMessageId: string;
  lastMessageAt: string;
};

export type PaginatedThreadHistoryResult = ThreadHistoryResult & {
  page: number;
  pageSize: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  nextPage: number | null;
  previousPage: number | null;
};

export type ThreadMutationResult = {
  profile: string;
  actorSlug: string;
  threadId: string;
  label: string;
};

export type CreateThreadResult = ThreadMutationResult & {
  kind: 'direct' | 'group';
  locked: boolean;
  participants: string[];
  invitedParticipants: string[];
  targetLookup?: ActorLookupMetadata;
  participantLookups?: ActorLookupMetadata[];
};

export type ThreadMembershipResult = ThreadMutationResult & {
  participant: string;
  action: 'added' | 'invited' | 'removed';
  participants: string[];
  invitedParticipants: string[];
  participantLookup?: ActorLookupMetadata;
};

export type ThreadReadResult = ThreadMutationResult & {
  throughMessageId: string;
};

export type ThreadArchiveResult = ThreadMutationResult & {
  archived: boolean;
};

export type ThreadDeleteResult = ThreadMutationResult;

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePage(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw userError('Page must be a positive integer.', {
      code: 'INVALID_PAGE',
    });
  }
  return value;
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) return 25;
  if (!Number.isInteger(value) || value < 1 || value > 25) {
    throw userError('Page size must be an integer between 1 and 25.', {
      code: 'INVALID_PAGE_SIZE',
    });
  }
  return value;
}

function parseThreadId(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 1n) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw userError('Thread id must be a positive integer.', {
      code: 'INVALID_THREAD_ID',
    });
  }
}

function parseMessageId(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw userError('Message id must be a non-negative integer.', {
      code: 'INVALID_MESSAGE_ID',
    });
  }
}

function emptyVisibleThreadPage(): VisibleThreadPage {
  return {
    actors: [],
    participantPreviews: [],
    readStates: [],
    threads: [],
    nextAfterSortKey: undefined,
  };
}

function toVisibleThreadPage(page: GeneratedVisibleThreadPage): VisibleThreadPage {
  return {
    actors: [...page.actors],
    participantPreviews: [...page.participantPreviews],
    readStates: page.participantPreviews.filter(participant => participant.lastReadMessageId !== undefined),
    threads: [...page.threads],
    nextAfterSortKey: page.nextAfterSortKey,
  };
}

async function readThreadMessagePageRows(params: {
  conn: DbConnection;
  agentDbId: bigint;
  threadId: bigint;
  beforeMessageId?: bigint;
  limit: number;
}): Promise<Pick<VisibleThreadMessagePage, 'messages' | 'secretEnvelopes' | 'nextBeforeMessageId'>> {
  const page = await params.conn.procedures.listThreadMessages({
    agentDbId: params.agentDbId,
    threadId: params.threadId,
    beforeMessageId: params.beforeMessageId,
    limit: params.limit,
  });

  return {
    messages: mergeRowsById(page.messages),
    secretEnvelopes: mergeRowsById(page.secretEnvelopes),
    nextBeforeMessageId: page.nextBeforeMessageId,
  };
}

function sortActors(left: Agent, right: Agent): number {
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

function requireDefaultActor(
  snapshot: MessageSnapshot,
  email: string
): Agent {
  const actor = findDefaultActorByEmail(snapshot.actors, email);
  if (!actor) {
    throw inboxBootstrapRequiredError();
  }

  return actor;
}

function resolveOwnedActor(params: {
  snapshot: MessageSnapshot;
  email: string;
  actorSlug?: string;
  threadId?: bigint;
}): Agent {
  if (params.actorSlug) {
    const normalizedSlug = normalizeInboxSlug(params.actorSlug);
    if (!normalizedSlug) {
      throw userError('Inbox slug is invalid.', {
        code: 'INVALID_SLUG',
      });
    }

    const exactOwnedActor =
      params.snapshot.actors.find(
        row => row.email === params.email && row.slug === normalizedSlug
      ) ?? null;
    if (exactOwnedActor) {
      return exactOwnedActor;
    }
  }

  const defaultActor = requireDefaultActor(params.snapshot, params.email);
  const ownedActors = params.snapshot.actors
    .filter(actor => actor.accountId === defaultActor.accountId)
    .sort(sortActors);

  if (params.actorSlug) {
    const normalizedSlug = normalizeInboxSlug(params.actorSlug);
    const actor = ownedActors.find(row => row.slug === normalizedSlug);
    if (!actor) {
      throw userError(`No owned inbox actor found for slug \`${normalizedSlug}\`.`, {
        code: 'OWNED_ACTOR_NOT_FOUND',
      });
    }
    return actor;
  }

  if (params.threadId !== undefined) {
    const participantsByThreadId = buildParticipantsByThreadId(
      params.snapshot.participants.filter(participant => participant.active)
    );
    const matchingActor =
      ownedActors.find(actor =>
        (participantsByThreadId.get(params.threadId!) ?? []).some(
          participant => participant.agentDbId === actor.id
        )
      ) ?? null;
    if (matchingActor) {
      return matchingActor;
    }
  }

  return defaultActor;
}

function requireThread(snapshot: MessageSnapshot, threadId: bigint): Thread {
  const thread = snapshot.threads.find(row => row.id === threadId);
  if (!thread) {
    throw userError(`Thread ${threadId.toString()} is not visible.`, {
      code: 'THREAD_NOT_FOUND',
    });
  }

  return thread;
}

function normalizeThreadListFilter(
  filter: string | undefined,
  includeArchived: boolean | undefined
): ThreadListFilter {
  if (filter === undefined) {
    return includeArchived ? 'all' : 'active';
  }
  if (filter === 'active' || filter === 'latest' || filter === 'archived' || filter === 'all') {
    return filter;
  }
  throw userError('Thread filter must be active, latest, archived, or all.', {
    code: 'INVALID_THREAD_FILTER',
  });
}

async function readVisibleThreadListPage(params: {
  conn: DbConnection;
  actorId: bigint;
  page: number;
  pageSize: number;
  afterSortKey?: string;
}): Promise<VisibleThreadPage> {
  if (params.afterSortKey && params.page > 1) {
    throw userError('Use either --after or --page, not both.', {
      code: 'THREAD_PAGE_CONFLICT',
    });
  }

  let afterSortKey = params.afterSortKey;
  for (let currentPage = 1; currentPage <= params.page; currentPage += 1) {
    const page = toVisibleThreadPage(await params.conn.procedures.listVisibleThreads({
      agentDbId: params.actorId,
      afterSortKey,
      limit: params.pageSize,
    }));
    if (currentPage === params.page) {
      return page;
    }
    if (page.nextAfterSortKey === undefined || page.nextAfterSortKey === null) {
      return emptyVisibleThreadPage();
    }
    afterSortKey = page.nextAfterSortKey;
  }

  return emptyVisibleThreadPage();
}

async function readVisibleThreadPageForActor(params: {
  conn: DbConnection;
  snapshot: MessageSnapshot;
  email: string;
  actorSlug?: string;
  threadId: bigint;
}): Promise<{ actor: Agent; page: VisibleThreadPage }> {
  const candidates = params.actorSlug
    ? [
        resolveOwnedActor({
          snapshot: params.snapshot,
          email: params.email,
          actorSlug: params.actorSlug,
        }),
      ]
    : (() => {
        const defaultActor = requireDefaultActor(params.snapshot, params.email);
        return params.snapshot.actors
          .filter(actor => actor.accountId === defaultActor.accountId)
          .sort(sortActors);
      })();

  for (const actor of candidates) {
    try {
      const candidatePage = await params.conn.procedures.readVisibleThread({
        agentDbId: actor.id,
        threadId: params.threadId,
      });
      if (candidatePage && candidatePage.threads.some(thread => thread.id === params.threadId)) {
        const page = toVisibleThreadPage(candidatePage);
        return { actor, page };
      }
    } catch {
      // Try the next owned actor before surfacing the not-found error.
    }
  }

  throw userError(`Thread ${params.threadId.toString()} is not visible.`, {
    code: 'THREAD_NOT_FOUND',
  });
}

function mergeVisibleThreadPageIntoSnapshot(
  snapshot: MessageSnapshot,
  page: VisibleThreadPage
): MessageSnapshot {
  return {
    ...snapshot,
    actors: mergeRowsById(snapshot.actors, page.actors),
    participants: mergeRowsById(snapshot.participants, page.participantPreviews),
    readStates: mergeRowsById(snapshot.readStates, page.readStates),
    threads: mergeRowsById(snapshot.threads, page.threads),
  };
}

async function readThreadScopedMetadataRows(params: {
  conn: DbConnection;
  email: string;
  actorSlug?: string;
  threadId: bigint;
}): Promise<{
  snapshot: MessageSnapshot;
  actor: Agent;
  thread: Thread;
  participant: ThreadParticipantPreview;
}> {
  const baseSnapshot = await readLatestMetadataRows(params.conn, {
    email: params.email,
    actorSlug: params.actorSlug,
  });
  const { actor, page } = await readVisibleThreadPageForActor({
    conn: params.conn,
    snapshot: baseSnapshot,
    email: params.email,
    actorSlug: params.actorSlug,
    threadId: params.threadId,
  });
  const participantPage = await readAllThreadParticipants(params.conn, params.threadId);
  const snapshot = mergeVisibleThreadPageIntoSnapshot(
    {
      ...baseSnapshot,
      actors: mergeRowsById(baseSnapshot.actors, participantPage.actors),
      participants: mergeRowsById(baseSnapshot.participants, participantPage.participants),
      readStates: mergeRowsById(
        baseSnapshot.readStates,
        participantPage.participants.filter(
          participant => participant.lastReadMessageId !== undefined
        )
      ),
    },
    page
  );
  const thread = requireThread(snapshot, params.threadId);
  const participant = requireActiveThreadParticipant(snapshot, params.threadId, actor.id);

  return {
    snapshot,
    actor,
    thread,
    participant,
  };
}

function requireActiveThreadParticipant(
  snapshot: MessageSnapshot,
  threadId: bigint,
  actorId: bigint
): ThreadParticipantPreview {
  const participant = snapshot.participants.find(row => {
    return row.threadId === threadId && row.agentDbId === actorId && row.active;
  });
  if (!participant) {
    throw userError(`Actor is not an active participant in thread ${threadId.toString()}.`, {
      code: 'THREAD_PARTICIPANT_REQUIRED',
    });
  }
  return participant;
}

function buildThreadLabel(params: {
  thread: Thread;
  participantsByThreadId: Map<bigint, ThreadParticipantPreview[]>;
  actorsById: Map<bigint, Agent>;
  ownActorIds: Set<bigint>;
}): string {
  return summarizeThread(
    params.thread,
    params.participantsByThreadId.get(params.thread.id) ?? [],
    params.actorsById,
    params.ownActorIds
  );
}


function isApprovalRequiredForFirstContactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('requires approval for first contact') ||
    normalized.includes('direct contact requires approval')
  );
}

async function waitForThread(params: {
  read: () => Promise<MessageSnapshot>;
  predicate: (snapshot: MessageSnapshot) => Thread | null;
  timeoutMs?: number;
}): Promise<Thread> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10_000);

  while (Date.now() < timeoutAt) {
    const match = params.predicate(await params.read());
    if (match) {
      return match;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for thread state to sync.', {
    code: 'SPACETIMEDB_THREAD_TIMEOUT',
  });
}

function listThreadParticipants(params: {
  participantsByThreadId: Map<bigint, ThreadParticipantPreview[]>;
  threadId: bigint;
  actorsById: Map<bigint, Agent>;
}): string[] {
  return (params.participantsByThreadId.get(params.threadId) ?? [])
    .map(participant => params.actorsById.get(participant.agentDbId)?.slug ?? null)
    .filter((slug): slug is string => Boolean(slug))
    .sort((left, right) => left.localeCompare(right));
}

function listPendingThreadInvitees(
  threadInvites: ThreadInvite[],
  threadId: bigint,
  actorsById: Map<bigint, Agent>
): string[] {
  return threadInvites
    .filter(invite => invite.threadId === threadId && invite.status.tag === 'Pending')
    .map(invite =>
      actorsById.get(invite.inviteeAgentDbId)?.slug ?? `agent#${invite.inviteeAgentDbId.toString()}`
    )
    .sort((left, right) => left.localeCompare(right));
}

function summarizeThreadMembership(
  snapshot: MessageSnapshot,
  threadId: bigint
): { participants: string[]; invitedParticipants: string[] } {
  const participantsByThreadId = buildParticipantsByThreadId(
    snapshot.participants.filter(participant => participant.active)
  );
  const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));

  return {
    participants: listThreadParticipants({
      participantsByThreadId,
      threadId,
      actorsById,
    }),
    invitedParticipants: listPendingThreadInvitees(snapshot.threadInvites, threadId, actorsById),
  };
}

function buildRepresentedThreadPublicIdentities(
  snapshot: MessageSnapshot,
  threadId: bigint
): Set<string> {
  const represented = new Set<string>();
  const actorsById = new Map(snapshot.actors.map(actor => [actor.id, actor] as const));

  for (const participant of snapshot.participants) {
    if (participant.threadId !== threadId || !participant.active) continue;
    const actor = actorsById.get(participant.agentDbId);
    if (actor) represented.add(actor.publicIdentity);
  }

  for (const invite of snapshot.threadInvites) {
    if (invite.threadId === threadId && invite.status.tag === 'Pending') {
      const inviteeActor = actorsById.get(invite.inviteeAgentDbId);
      if (inviteeActor) {
        represented.add(inviteeActor.publicIdentity);
      }
    }
  }

  return represented;
}

async function waitForThreadMembership(params: {
  read: () => Promise<MessageSnapshot>;
  threadId: bigint;
  expectedPublicIdentities: Set<string>;
  timeoutMs?: number;
}): Promise<MessageSnapshot> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10_000);

  while (Date.now() < timeoutAt) {
    const snapshot = await params.read();
    const represented = buildRepresentedThreadPublicIdentities(snapshot, params.threadId);
    const complete = Array.from(params.expectedPublicIdentities).every(publicIdentity =>
      represented.has(publicIdentity)
    );
    if (complete) {
      return snapshot;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for thread membership to sync.', {
    code: 'SPACETIMEDB_THREAD_MEMBERSHIP_TIMEOUT',
  });
}

export async function listThreads(params: {
  profileName: string;
  actorSlug?: string;
  includeArchived?: boolean;
  filter?: string;
  page?: number;
  pageSize?: number;
  afterSortKey?: string;
  reporter: TaskReporter;
}): Promise<ThreadListResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
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
    params.reporter.verbose?.('Reading latest thread state');
    const snapshot = await readLatestMetadataRows(conn, {
      email,
      actorSlug: params.actorSlug,
    });
    const actor = resolveOwnedActor({
      snapshot,
      email,
      actorSlug: params.actorSlug,
    });
    const page = normalizePage(params.page);
    const pageSize = normalizePageSize(params.pageSize);
    const filter = normalizeThreadListFilter(params.filter, params.includeArchived);
    const threadPage = await readVisibleThreadListPage({
      conn,
      actorId: actor.id,
      page,
      pageSize,
      afterSortKey: params.afterSortKey,
    });
    const mergedActors = mergeRowsById(snapshot.actors, threadPage.actors);
    const ownActorIds = buildOwnActorIds(mergedActors, actor.accountId);
    const participantsByThreadId = buildParticipantsByThreadId(
      threadPage.participantPreviews.filter(participant => participant.active)
    );
    const actorsById = new Map(mergedActors.map(row => [row.id, row] as const));
    const readStateByThreadId = buildReadStateByThreadId(threadPage.readStates, actor.id);

    const filteredThreads = threadPage.threads.filter(thread => {
      const archived = readStateByThreadId.get(thread.id)?.archived ?? false;
      if (filter === 'archived') return archived;
      if (filter === 'active') return !archived;
      return true;
    });

    const threads = filteredThreads.map(thread => {
      const readState = readStateByThreadId.get(thread.id);
      const lastRead = readState?.lastReadMessageId ?? 0n;
      const lastAssigned = thread.lastMessageId;
      const unreadMessages =
        lastAssigned > lastRead ? 1 : 0;

      return {
        id: thread.id.toString(),
        kind: thread.kind.tag === 'Direct' ? 'direct' : 'group',
        label: buildThreadLabel({
          thread,
          participantsByThreadId,
          actorsById,
          ownActorIds,
        }),
        locked: thread.kind.tag === 'Direct',
        archived: readState?.archived ?? false,
        unreadMessages,
        participantCount: Number(thread.activeParticipantCount),
        participants: listThreadParticipants({
          participantsByThreadId,
          threadId: thread.id,
          actorsById,
        }),
        lastMessageAt: timestampToISOString(thread.lastMessageAt),
        lastMessageId: thread.lastMessageId.toString(),
      } satisfies ThreadListItem;
    });

      params.reporter.success(
        `Loaded ${threads.length} visible thread${threads.length === 1 ? '' : 's'}`
      );

      return {
        authenticated: true,
        connected: true,
        profile: profile.name,
        actorSlug: actor.slug,
        includeArchived: Boolean(params.includeArchived),
        filter,
        page,
        pageSize,
        hasPrevious: Boolean(params.afterSortKey) || page > 1,
        hasNext: threadPage.nextAfterSortKey !== null && threadPage.nextAfterSortKey !== undefined,
        nextAfterSortKey: threadPage.nextAfterSortKey ?? null,
        totalThreads: threads.length,
        threads,
      };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to list threads.', {
      code: 'THREAD_LIST_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function countThreadMessages(params: {
  profileName: string;
  threadId: string;
  actorSlug?: string;
  reporter: TaskReporter;
}): Promise<ThreadMessageCountResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread message state');
    const snapshot = await readLatestMetadataRows(conn, {
      email,
      actorSlug: params.actorSlug,
    });
      const { actor, page: initialPage } = await readVisibleThreadPageForActor({
        conn,
        snapshot,
        email,
        actorSlug: params.actorSlug,
        threadId: requestedThreadId,
      });
      const refreshed = await conn.procedures.readVisibleThread({
        agentDbId: actor.id,
        threadId: requestedThreadId,
      });
      const page: VisibleThreadPage =
        refreshed && refreshed.threads.some(row => row.id === requestedThreadId)
          ? toVisibleThreadPage(refreshed)
          : initialPage;
      const thread = requireThread(
        { ...snapshot, threads: page.threads },
        requestedThreadId
      );
      requireActiveThreadParticipant(
        { ...snapshot, participants: page.participantPreviews },
        requestedThreadId,
        actor.id
      );

      const ownActorIds = buildOwnActorIds(snapshot.actors, actor.accountId);
      const participantsByThreadId = buildParticipantsByThreadId(
        page.participantPreviews.filter(participant => participant.active)
      );
      const actorsById = new Map(
        mergeRowsById(snapshot.actors, page.actors).map(row => [row.id, row] as const)
      );
      const readState = buildReadStateByThreadId(page.participantPreviews, actor.id).get(thread.id);
      const participants = listThreadParticipants({
        participantsByThreadId,
        threadId: thread.id,
        actorsById,
      });
      const messageCount = Number(thread.messageCount);
      const label = buildThreadLabel({
        thread,
        participantsByThreadId,
        actorsById,
        ownActorIds,
      });

      params.reporter.success(
        `Counted ${messageCount} message${
          messageCount === 1 ? '' : 's'
        } in thread ${thread.id.toString()}`
      );

      return {
        authenticated: true,
        connected: true,
        profile: profile.name,
        actorSlug: actor.slug,
        thread: {
          id: thread.id.toString(),
          kind: thread.kind.tag === 'Direct' ? 'direct' : 'group',
          label,
          locked: thread.kind.tag === 'Direct',
          archived: readState?.archived ?? false,
          participantCount: Number(thread.activeParticipantCount),
          participants,
        },
        messageCount,
        lastMessageId: thread.lastMessageId.toString(),
        lastMessageAt: timestampToISOString(thread.lastMessageAt),
      };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to count thread messages.', {
      code: 'THREAD_MESSAGE_COUNT_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function readThreadHistory(params: {
  profileName: string;
  threadId: string;
  actorSlug?: string;
  page?: number;
  pageSize?: number;
  reporter: TaskReporter;
  readUnsupported?: boolean;
}): Promise<PaginatedThreadHistoryResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);
  const secretStore = createSecretStore();

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread history');
    const snapshot = await readLatestMetadataRows(conn, {
      email,
      actorSlug: params.actorSlug,
    });
      const { actor, page: initialPage } = await readVisibleThreadPageForActor({
        conn,
        snapshot,
        email,
        actorSlug: params.actorSlug,
        threadId: requestedThreadId,
      });
      const refreshed = await conn.procedures.readVisibleThread({
        agentDbId: actor.id,
        threadId: requestedThreadId,
      });
      const page: VisibleThreadPage =
        refreshed && refreshed.threads.some(row => row.id === requestedThreadId)
          ? toVisibleThreadPage(refreshed)
          : initialPage;
      const thread = requireThread(
        { ...snapshot, threads: page.threads },
        requestedThreadId
      );
      requireActiveThreadParticipant(
        { ...snapshot, participants: page.participantPreviews },
        requestedThreadId,
        actor.id
      );

      const mergedActors = mergeRowsById(snapshot.actors, page.actors);
      const ownActorIds = buildOwnActorIds(mergedActors, actor.accountId);
      const participantsByThreadId = buildParticipantsByThreadId(
        page.participantPreviews.filter(participant => participant.active)
      );
      const actorsById = new Map(mergedActors.map(row => [row.id, row] as const));

      const requestedPage = normalizePage(params.page);
      const pageSize = normalizePageSize(params.pageSize);
      const totalMessages = Number(thread.messageCount);
      const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
      const boundedPage = Math.min(requestedPage, totalPages);

      const recipientKeyPairs = await getStoredActorKeyPairs({
        profile,
        secretStore,
        identity: {
          email: actor.email,
          slug: actor.slug,
        },
      });

      let beforeMessageId: bigint | undefined;
      let historyRows: Pick<VisibleThreadMessagePage, 'messages' | 'secretEnvelopes' | 'nextBeforeMessageId'> = {
        messages: [],
        secretEnvelopes: [],
        nextBeforeMessageId: undefined,
      };
      for (let currentPage = 1; currentPage <= boundedPage; currentPage += 1) {
        historyRows = await readThreadMessagePageRows({
          conn,
          agentDbId: actor.id,
          threadId: requestedThreadId,
          beforeMessageId,
          limit: pageSize,
        });
        beforeMessageId = historyRows.nextBeforeMessageId ?? undefined;
        if (historyRows.messages.length === 0 || beforeMessageId === undefined) {
          break;
        }
      }
      const secretEnvelopes = mergeRowsById(
        snapshot.secretEnvelopes,
        historyRows.secretEnvelopes
      );
      const publicKeysByActorId = buildPublicKeysByActorId(
        await lookupMessagePublicKeys({
          conn,
          agentDbId: actor.id,
          messages: historyRows.messages,
          secretEnvelopes,
          actorsById,
        })
      );

      const messages = await Promise.all(
        historyRows.messages
          .filter(message => message.threadId === requestedThreadId)
          .sort((left, right) => compareBigInt(left.id, right.id))
          .map(async message => {
            const senderActor = actorsById.get(message.senderAgentDbId);
            const decrypted = await decryptVisibleMessage({
              message,
              defaultActor: actor,
              actorsById,
              publicKeysByActorId,
              ownActorIds,
              secretEnvelopes,
              recipientKeyPair: recipientKeyPairs[0] ?? null,
              recipientKeyPairs,
              readUnsupported: params.readUnsupported,
              allowFirstContactTrust:
                thread.messageCount === 1n && thread.lastMessageId === message.id,
            });

            return {
              id: message.id.toString(),
              messageId: message.id.toString(),
              secretVersion: message.secretVersion.toString(),
              createdAt: timestampToISOString(message.createdAt),
              sender: {
                id: senderActor?.id.toString() ?? message.senderAgentDbId.toString(),
                slug: senderActor?.slug ?? 'unknown',
                displayName: senderActor?.displayName ?? null,
                publicIdentity: senderActor?.publicIdentity ?? 'unknown',
              },
              text: decrypted.text,
              decryptStatus: decrypted.decryptStatus,
              decryptError: decrypted.decryptError,
              contentType: decrypted.contentType,
              headerNames: decrypted.headerNames,
              headers: decrypted.headers,
              unsupportedReasons: decrypted.unsupportedReasons,
              legacyPlaintext: decrypted.legacyPlaintext,
              replyToMessageId: message.replyToMessageId?.toString() ?? null,
              trustStatus: decrypted.trustStatus,
              trustNotice: decrypted.trustNotice,
              trustWarning: decrypted.trustWarning,
            } satisfies ThreadHistoryMessage;
          })
      );

      const readState = buildReadStateByThreadId(page.participantPreviews, actor.id).get(thread.id);
      const lastReadMessageId = readState?.lastReadMessageId?.toString() ?? '0';
      const label = buildThreadLabel({
        thread,
        participantsByThreadId,
        actorsById,
        ownActorIds,
      });

      params.reporter.success(
        `Loaded ${messages.length} message${messages.length === 1 ? '' : 's'} from thread ${thread.id.toString()}`
      );

      return {
        authenticated: true,
        connected: true,
        profile: profile.name,
        actorSlug: actor.slug,
        thread: {
          id: thread.id.toString(),
          kind: thread.kind.tag === 'Direct' ? 'direct' : 'group',
          label,
          locked: thread.kind.tag === 'Direct',
          archived: readState?.archived ?? false,
        },
        lastReadMessageId,
        totalMessages,
        page: boundedPage,
        pageSize,
        totalPages,
        hasPrevious: boundedPage > 1,
        hasNext: boundedPage < totalPages,
        previousPage: boundedPage > 1 ? boundedPage - 1 : null,
        nextPage: boundedPage < totalPages ? boundedPage + 1 : null,
        messages,
      };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to load thread history.', {
      code: 'THREAD_HISTORY_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export function paginateThreadHistory(
  history: ThreadHistoryResult,
  params?: {
    page?: number;
    pageSize?: number;
  }
): PaginatedThreadHistoryResult {
  const page = normalizePage(params?.page);
  const pageSize = normalizePageSize(params?.pageSize);
  const totalPages = Math.max(1, Math.ceil(history.totalMessages / pageSize));
  const boundedPage = Math.min(page, totalPages);
  const start = (boundedPage - 1) * pageSize;
  const end = start + pageSize;

  return {
    ...history,
    page: boundedPage,
    pageSize,
    totalPages,
    hasPrevious: boundedPage > 1,
    hasNext: boundedPage < totalPages,
    previousPage: boundedPage > 1 ? boundedPage - 1 : null,
    nextPage: boundedPage < totalPages ? boundedPage + 1 : null,
    messages: history.messages.slice(start, end),
  };
}

export async function createDirectThread(params: {
  profileName: string;
  actorSlug?: string;
  to: string;
  title?: string;
  reporter: TaskReporter;
}): Promise<CreateThreadResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
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
    params.reporter.verbose?.('Reading latest thread state');
    const read = () =>
      readLatestMetadataRows(conn, {
        email,
        actorSlug: params.actorSlug,
      });
    const snapshot = await read();
    const actor = resolveOwnedActor({
      snapshot,
      email,
      actorSlug: params.actorSlug,
    });
    const targetLookup = await resolvePublishedActorLookup({
      identifier: params.to,
      lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
      lookupByEmail: input =>
        conn.procedures.lookupPublishedAgentsByEmailPage({
          ...input,
          afterId: undefined,
          limit: undefined,
        }),
      invalidMessage: 'Inbox slug or email is invalid.',
      invalidCode: 'INVALID_AGENT_IDENTIFIER',
      notFoundCode: 'ACTOR_NOT_FOUND',
      fallbackMessage: 'Unable to resolve inbox slug or email.',
    });
    const target = targetLookup.selected;
    if (target.publicIdentity === actor.publicIdentity) {
      throw userError('Use a different inbox slug or email for a direct thread.', {
        code: 'DIRECT_THREAD_SELF',
      });
    }

    const targetActorId = findActorIdByPublicIdentity(snapshot.actors, target.publicIdentity);
    const beforeThreadIds = new Set(
      snapshot.threads
        .filter(thread =>
          targetActorId !== null && isDirectThreadBetween(thread, actor.id, targetActorId)
        )
        .map(thread => thread.id.toString())
    );

    try {
      await conn.reducers.createThread({
        agentDbId: actor.id,
        kind: { tag: 'Direct' },
        otherAgentPublicIdentity: target.publicIdentity,
        participantPublicIdentities: undefined,
        title: params.title?.trim() || undefined,
      });
    } catch (error) {
      if (isApprovalRequiredForFirstContactError(error)) {
        throw userError(
          'This recipient requires approval for first contact. Use `masumi-agent-messenger thread start <agent> "<message>"` to create the approval request with a first encrypted message.',
          {
            code: 'DIRECT_THREAD_APPROVAL_REQUIRED',
          }
        );
      }
      throw error;
    }

    const thread = await waitForThread({
      read,
      predicate: nextSnapshot => {
        const nextTargetActorId = findActorIdByPublicIdentity(
          nextSnapshot.actors,
          target.publicIdentity
        );
        if (nextTargetActorId === null) return null;
        return (
          nextSnapshot.threads.find(
            row =>
              isDirectThreadBetween(row, actor.id, nextTargetActorId) &&
              !beforeThreadIds.has(row.id.toString())
          ) ?? null
        );
      },
    });

    params.reporter.success(`Created direct thread ${thread.id.toString()}`);

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: params.title?.trim() || target.displayName || target.slug,
      kind: 'direct',
      locked: thread.kind.tag === 'Direct',
      participants: [actor.slug, target.slug].sort((left, right) => left.localeCompare(right)),
      invitedParticipants: [],
      targetLookup: {
        input: targetLookup.input,
        inputKind: targetLookup.inputKind,
        matchedActors: targetLookup.matchedActors,
        selected: targetLookup.selectedActor,
      },
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to create a direct thread.', {
      code: 'THREAD_CREATE_DIRECT_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function createGroupThread(params: {
  profileName: string;
  actorSlug?: string;
  participants: string[];
  title?: string;
  locked?: boolean;
  reporter: TaskReporter;
}): Promise<CreateThreadResult> {
  if (params.participants.length === 0) {
    throw userError('Provide at least one participant slug or email.', {
      code: 'GROUP_THREAD_PARTICIPANTS_REQUIRED',
    });
  }

  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
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
    params.reporter.verbose?.('Reading latest thread state');
    const read = () =>
      readLatestMetadataRows(conn, {
        email,
        actorSlug: params.actorSlug,
      });
    const snapshot = await read();
    const actor = resolveOwnedActor({
      snapshot,
      email,
      actorSlug: params.actorSlug,
    });
    const resolvedParticipants = await Promise.all(
      Array.from(new Set(params.participants)).map(identifier =>
        resolvePublishedActorLookup({
          identifier,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input =>
            conn.procedures.lookupPublishedAgentsByEmailPage({
              ...input,
              afterId: undefined,
              limit: undefined,
            }),
          invalidMessage: 'Participant slug or email is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to resolve participant slug or email.',
        })
      )
    );
    const participantPublicIdentities = resolvedParticipants
      .filter(participant => participant.selected.publicIdentity !== actor.publicIdentity)
      .map(participant => participant.selected.publicIdentity);

    const beforeThreadIds = new Set(snapshot.threads.map(thread => thread.id.toString()));
    // Direct/group behavior is encoded in `kind`.
    void params.locked;
    await conn.reducers.createThread({
      agentDbId: actor.id,
      kind: { tag: 'Group' },
      otherAgentPublicIdentity: undefined,
      participantPublicIdentities,
      title: params.title?.trim() || undefined,
    });

    const thread = await waitForThread({
      read,
      predicate: nextSnapshot =>
        nextSnapshot.threads.find(row => {
          return (
            row.kind.tag === 'Group' &&
            row.creatorAgentDbId === actor.id &&
            !beforeThreadIds.has(row.id.toString())
          );
        }) ?? null,
    });
    const membershipSnapshot = await waitForThreadMembership({
      read,
      threadId: thread.id,
      expectedPublicIdentities: new Set([
        actor.publicIdentity,
        ...participantPublicIdentities,
      ]),
    });
    const membership = summarizeThreadMembership(membershipSnapshot, thread.id);

    params.reporter.success(`Created group thread ${thread.id.toString()}`);

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: params.title?.trim() || `Group thread ${thread.id.toString()}`,
      kind: 'group',
      locked: thread.kind.tag === 'Direct',
      participants: membership.participants,
      invitedParticipants: membership.invitedParticipants,
      participantLookups: resolvedParticipants.map(participant => ({
        input: participant.input,
        inputKind: participant.inputKind,
        matchedActors: participant.matchedActors,
        selected: participant.selectedActor,
      })),
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to create a group thread.', {
      code: 'THREAD_CREATE_GROUP_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function addThreadParticipant(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  participant: string;
  reporter: TaskReporter;
}): Promise<ThreadMembershipResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread state');
    const read = () =>
      readThreadScopedMetadataRows({
        conn,
        email,
        actorSlug: params.actorSlug,
        threadId: requestedThreadId,
      }).then(result => result.snapshot);
    const { actor } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    const targetLookup = await resolvePublishedActorLookup({
      identifier: params.participant,
      lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
      lookupByEmail: input =>
        conn.procedures.lookupPublishedAgentsByEmailPage({
          ...input,
          afterId: undefined,
          limit: undefined,
        }),
      invalidMessage: 'Participant slug or email is invalid.',
      invalidCode: 'INVALID_AGENT_IDENTIFIER',
      notFoundCode: 'ACTOR_NOT_FOUND',
      fallbackMessage: 'Unable to resolve participant slug or email.',
    });
    const target = targetLookup.selected;

    await conn.reducers.addThreadParticipant({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      inviteePublicIdentity: target.publicIdentity,
    });

    const membershipSnapshot = await waitForThreadMembership({
      read,
      threadId: requestedThreadId,
      expectedPublicIdentities: new Set([target.publicIdentity]),
    });
    const thread = requireThread(membershipSnapshot, requestedThreadId);
    const membership = summarizeThreadMembership(membershipSnapshot, requestedThreadId);
    const targetIsActive = membershipSnapshot.participants.some(participant => {
      const participantActor = membershipSnapshot.actors.find(
        candidate => candidate.id === participant.agentDbId
      );
      return (
        participant.threadId === requestedThreadId &&
        participant.active &&
        participantActor?.publicIdentity === target.publicIdentity
      );
    });
    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
      participant: target.slug,
      action: targetIsActive ? 'added' : 'invited',
      participants: membership.participants,
      invitedParticipants: membership.invitedParticipants,
      participantLookup: {
        input: targetLookup.input,
        inputKind: targetLookup.inputKind,
        matchedActors: targetLookup.matchedActors,
        selected: targetLookup.selectedActor,
      },
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to add the thread participant.', {
      code: 'THREAD_ADD_PARTICIPANT_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function removeThreadParticipant(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  participant: string;
  reporter: TaskReporter;
}): Promise<ThreadMembershipResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);
  const requestedParticipantSlug = normalizeInboxSlug(params.participant);
  if (!requestedParticipantSlug) {
    throw userError('Participant slug is invalid.', {
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
    params.reporter.verbose?.('Reading latest thread state');
    const { snapshot, actor } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });

    const threadParticipants = snapshot.participants.filter(row => {
      return row.threadId === requestedThreadId && row.active;
    });
    const actorsById = new Map(snapshot.actors.map(row => [row.id, row] as const));
    const targetActor = threadParticipants
      .map(participant => actorsById.get(participant.agentDbId))
      .find(candidate => candidate?.slug === requestedParticipantSlug);
    if (!targetActor) {
      throw userError(
        `No active participant \`${requestedParticipantSlug}\` is visible in this thread.`,
        {
          code: 'THREAD_PARTICIPANT_NOT_FOUND',
        }
      );
    }

    await conn.reducers.removeThreadParticipant({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      targetAgentDbId: targetActor.id,
    });

    const { snapshot: nextSnapshot } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    const thread = requireThread(nextSnapshot, requestedThreadId);
    const membership = summarizeThreadMembership(nextSnapshot, requestedThreadId);
    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
      participant: targetActor.slug,
      action: 'removed',
      participants: membership.participants,
      invitedParticipants: membership.invitedParticipants,
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to remove the thread participant.', {
      code: 'THREAD_REMOVE_PARTICIPANT_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function markThreadRead(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  throughMessageId?: string;
  reporter: TaskReporter;
}): Promise<ThreadReadResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread state');
    const { actor, thread } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });

    const lastAssignedMessageId = thread.lastMessageId;
    const throughMessageId = params.throughMessageId
      ? parseMessageId(params.throughMessageId)
      : lastAssignedMessageId;
    if (throughMessageId > lastAssignedMessageId) {
      throw userError(
        `Message id cannot be greater than the latest message id (${lastAssignedMessageId.toString()}).`,
        { code: 'MESSAGE_ID_OUT_OF_RANGE' }
      );
    }
    await conn.reducers.updateThreadReadState({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      lastReadMessageId: throughMessageId,
      archived: undefined,
    });

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
      throughMessageId: throughMessageId.toString(),
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to mark the thread as read.', {
      code: 'THREAD_MARK_READ_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function setThreadArchived(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  archived: boolean;
  reporter: TaskReporter;
}): Promise<ThreadArchiveResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread state');
    const { actor, thread } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });

    await conn.reducers.updateThreadReadState({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      lastReadMessageId: undefined,
      archived: params.archived,
    });

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
      archived: params.archived,
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to update the thread archive state.', {
      code: 'THREAD_ARCHIVE_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function deleteThread(params: {
  profileName: string;
  actorSlug?: string;
  threadId: string;
  reporter: TaskReporter;
}): Promise<ThreadDeleteResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const requestedThreadId = parseThreadId(params.threadId);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Reading latest thread state');
    const { actor, thread } = await readThreadScopedMetadataRows({
      conn,
      email,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });

    await conn.reducers.deleteThread({
      agentDbId: actor.id,
      threadId: requestedThreadId,
    });

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to delete the thread.', {
      code: 'THREAD_DELETE_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}
