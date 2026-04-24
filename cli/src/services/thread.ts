import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  summarizeThread,
} from '../../../shared/inbox-state';
import {
  type PublishedActorIdentifierInputKind,
  type ResolvedPublishedActor,
} from '../../../shared/published-actors';
import { timestampToISOString } from '../../../shared/spacetime-time';
import type {
  VisibleAgentRow,
  VisibleAgentKeyBundleRow,
  VisibleThreadParticipantRow,
  VisibleThreadReadStateRow,
  VisibleThreadRow,
  VisibleThreadInviteRow,
  VisibleMessageSnapshot,
} from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import { getStoredActorKeyPair } from './actor-keys';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import { createSecretStore } from './secret-store';
import { decryptVisibleMessage } from './messages';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import {
  connectAuthenticated,
  disconnectConnection,
  readLatestMessageRows,
} from './spacetimedb';
import type { EncryptedMessageHeader } from '../../../shared/message-format';

type MessageSnapshot = VisibleMessageSnapshot;

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
  lastMessageSeq: string;
};

export type ThreadListResult = {
  authenticated: true;
  connected: true;
  profile: string;
  actorSlug: string;
  includeArchived: boolean;
  totalThreads: number;
  threads: ThreadListItem[];
};

export type ThreadHistoryMessage = {
  id: string;
  threadSeq: string;
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
  lastReadThreadSeq: string;
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
  lastMessageSeq: string;
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
  throughSeq: string;
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

function compareBigIntDesc(left: bigint, right: bigint): number {
  return compareBigInt(right, left);
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
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw userError('Page size must be an integer between 1 and 100.', {
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

function sortActors(left: VisibleAgentRow, right: VisibleAgentRow): number {
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
  normalizedEmail: string
): VisibleAgentRow {
  const actor = findDefaultActorByEmail(snapshot.actors, normalizedEmail);
  if (!actor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }

  return actor;
}

function resolveOwnedActor(params: {
  snapshot: MessageSnapshot;
  normalizedEmail: string;
  actorSlug?: string;
  threadId?: bigint;
}): VisibleAgentRow {
  const defaultActor = requireDefaultActor(params.snapshot, params.normalizedEmail);
  const ownedActors = params.snapshot.actors
    .filter(actor => actor.inboxId === defaultActor.inboxId)
    .sort(sortActors);

  if (params.actorSlug) {
    const normalizedSlug = normalizeInboxSlug(params.actorSlug);
    if (!normalizedSlug) {
      throw userError('Inbox slug is invalid.', {
        code: 'INVALID_SLUG',
      });
    }

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

function requireThread(snapshot: MessageSnapshot, threadId: bigint): VisibleThreadRow {
  const thread = snapshot.threads.find(row => row.id === threadId);
  if (!thread) {
    throw userError(`Thread ${threadId.toString()} is not visible.`, {
      code: 'THREAD_NOT_FOUND',
    });
  }

  return thread;
}

function requireActiveThreadParticipant(
  snapshot: MessageSnapshot,
  threadId: bigint,
  actorId: bigint
): VisibleThreadParticipantRow {
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
  thread: VisibleThreadRow;
  participantsByThreadId: Map<bigint, VisibleThreadParticipantRow[]>;
  actorsById: Map<bigint, VisibleAgentRow>;
  ownActorIds: Set<bigint>;
}): string {
  return summarizeThread(
    params.thread,
    params.participantsByThreadId.get(params.thread.id) ?? [],
    params.actorsById,
    params.ownActorIds
  );
}

function buildDirectKey(
  left: { publicIdentity: string },
  right: { publicIdentity: string }
): string {
  const values = [left.publicIdentity, right.publicIdentity].sort();
  return `direct:${values[0]}:${values[1]}`;
}

function isApprovalRequiredForFirstContactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('requires approval for first contact');
}

async function waitForThread(params: {
  read: () => Promise<MessageSnapshot>;
  predicate: (snapshot: MessageSnapshot) => VisibleThreadRow | null;
  timeoutMs?: number;
}): Promise<VisibleThreadRow> {
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
  participantsByThreadId: Map<bigint, VisibleThreadParticipantRow[]>;
  threadId: bigint;
  actorsById: Map<bigint, VisibleAgentRow>;
}): string[] {
  return (params.participantsByThreadId.get(params.threadId) ?? [])
    .map(participant => params.actorsById.get(participant.agentDbId)?.slug ?? null)
    .filter((slug): slug is string => Boolean(slug))
    .sort((left, right) => left.localeCompare(right));
}

function listPendingThreadInvitees(
  threadInvites: VisibleThreadInviteRow[],
  threadId: bigint
): string[] {
  return threadInvites
    .filter(invite => invite.threadId === threadId && invite.status === 'pending')
    .map(invite => invite.inviteeSlug)
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
    invitedParticipants: listPendingThreadInvitees(snapshot.threadInvites, threadId),
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
    if (invite.threadId === threadId && invite.status === 'pending') {
      represented.add(invite.inviteePublicIdentity);
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
  reporter: TaskReporter;
}): Promise<ThreadListResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
      const actor = resolveOwnedActor({
        snapshot,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const ownActorIds = buildOwnActorIds(snapshot.actors, actor.inboxId);
      const participantsByThreadId = buildParticipantsByThreadId(
        snapshot.participants.filter(participant => participant.active)
      );
      const actorsById = new Map(snapshot.actors.map(row => [row.id, row] as const));
      const readStateByThreadId = buildReadStateByThreadId(snapshot.readStates, actor.id);

      const threads = snapshot.threads
        .filter(thread =>
          (participantsByThreadId.get(thread.id) ?? []).some(
            participant => participant.agentDbId === actor.id
          )
        )
        .filter(thread => {
          if (params.includeArchived) {
            return true;
          }
          return !(readStateByThreadId.get(thread.id)?.archived ?? false);
        })
        .sort((left, right) => {
          const byTime = compareBigIntDesc(
            left.lastMessageAt.microsSinceUnixEpoch,
            right.lastMessageAt.microsSinceUnixEpoch
          );
          if (byTime !== 0) return byTime;
          return compareBigIntDesc(left.id, right.id);
        })
        .map(thread => {
          const readState = readStateByThreadId.get(thread.id);
          const lastRead = readState?.lastReadThreadSeq ?? 0n;
          const unreadMessages =
            thread.lastMessageSeq > lastRead ? Number(thread.lastMessageSeq - lastRead) : 0;

          return {
            id: thread.id.toString(),
            kind: thread.kind,
            label: buildThreadLabel({
              thread,
              participantsByThreadId,
              actorsById,
              ownActorIds,
            }),
            locked: thread.membershipLocked,
            archived: readState?.archived ?? false,
            unreadMessages,
            participantCount: (participantsByThreadId.get(thread.id) ?? []).length,
            participants: listThreadParticipants({
              participantsByThreadId,
              threadId: thread.id,
              actorsById,
            }),
            lastMessageAt: timestampToISOString(thread.lastMessageAt),
            lastMessageSeq: thread.lastMessageSeq.toString(),
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
      const actor = resolveOwnedActor({
        snapshot,
        normalizedEmail,
        actorSlug: params.actorSlug,
        threadId: requestedThreadId,
      });
      const thread = requireThread(snapshot, requestedThreadId);
      requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);

      const ownActorIds = buildOwnActorIds(snapshot.actors, actor.inboxId);
      const participantsByThreadId = buildParticipantsByThreadId(
        snapshot.participants.filter(participant => participant.active)
      );
      const actorsById = new Map(snapshot.actors.map(row => [row.id, row] as const));
      const readState = buildReadStateByThreadId(snapshot.readStates, actor.id).get(thread.id);
      const participants = listThreadParticipants({
        participantsByThreadId,
        threadId: thread.id,
        actorsById,
      });
      const messageCount = snapshot.messages.filter(
        message => message.threadId === requestedThreadId
      ).length;
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
          kind: thread.kind,
          label,
          locked: thread.membershipLocked,
          archived: readState?.archived ?? false,
          participantCount: participants.length,
          participants,
        },
        messageCount,
        lastMessageSeq: thread.lastMessageSeq.toString(),
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
  reporter: TaskReporter;
  readUnsupported?: boolean;
}): Promise<ThreadHistoryResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
      const actor = resolveOwnedActor({
        snapshot,
        normalizedEmail,
        actorSlug: params.actorSlug,
        threadId: requestedThreadId,
      });
      const thread = requireThread(snapshot, requestedThreadId);
      requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);

      const ownActorIds = buildOwnActorIds(snapshot.actors, actor.inboxId);
      const participantsByThreadId = buildParticipantsByThreadId(
        snapshot.participants.filter(participant => participant.active)
      );
      const actorsById = new Map(snapshot.actors.map(row => [row.id, row] as const));
      const bundlesByActorId = new Map<bigint, VisibleAgentKeyBundleRow[]>();
      for (const bundle of snapshot.bundles) {
        const list = bundlesByActorId.get(bundle.agentDbId) ?? [];
        list.push(bundle);
        bundlesByActorId.set(bundle.agentDbId, list);
      }

      const recipientKeyPair = await getStoredActorKeyPair({
        profile,
        secretStore,
        identity: {
          normalizedEmail: actor.normalizedEmail,
          slug: actor.slug,
          inboxIdentifier: actor.inboxIdentifier ?? undefined,
        },
      });

      const messages = await Promise.all(
        snapshot.messages
          .filter(message => message.threadId === requestedThreadId)
          .sort((left, right) => compareBigInt(left.threadSeq, right.threadSeq))
          .map(async message => {
            const senderActor = actorsById.get(message.senderAgentDbId);
            const decrypted = await decryptVisibleMessage({
              message,
              defaultActor: actor,
              actorsById,
              bundlesByActorId,
              ownActorIds,
              secretEnvelopes: snapshot.secretEnvelopes,
              recipientKeyPair,
              readUnsupported: params.readUnsupported,
            });

            return {
              id: message.id.toString(),
              threadSeq: message.threadSeq.toString(),
              secretVersion: message.secretVersion,
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

      const readState = buildReadStateByThreadId(snapshot.readStates, actor.id).get(thread.id);
      const lastReadThreadSeq = readState?.lastReadThreadSeq?.toString() ?? '0';
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
          kind: thread.kind,
          label,
          locked: thread.membershipLocked,
          archived: readState?.archived ?? false,
        },
        lastReadThreadSeq,
        totalMessages: messages.length,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const read = () => readLatestMessageRows(conn);
    const snapshot = await read();
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const targetLookup = await resolvePublishedActorLookup({
      identifier: params.to,
      lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
      lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
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

    const beforeThreadIds = new Set(
      snapshot.threads
        .filter(thread => {
          return (
            thread.kind === 'direct' &&
            thread.dedupeKey === buildDirectKey(actor, {
              publicIdentity: target.publicIdentity,
            })
          );
        })
        .map(thread => thread.id.toString())
    );

    try {
      await conn.reducers.createDirectThread({
        agentDbId: actor.id,
        otherAgentPublicIdentity: target.publicIdentity,
        membershipLocked: undefined,
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
      predicate: nextSnapshot =>
        nextSnapshot.threads.find(row => {
          return (
            row.kind === 'direct' &&
            row.dedupeKey === buildDirectKey(actor, {
              publicIdentity: target.publicIdentity,
            }) &&
            !beforeThreadIds.has(row.id.toString())
          );
        }) ?? null,
    });

    params.reporter.success(`Created direct thread ${thread.id.toString()}`);

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: params.title?.trim() || target.displayName || target.slug,
      kind: 'direct',
      locked: thread.membershipLocked,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const read = () => readLatestMessageRows(conn);
    const snapshot = await read();
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
    });
    const resolvedParticipants = await Promise.all(
      Array.from(new Set(params.participants)).map(identifier =>
        resolvePublishedActorLookup({
          identifier,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
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
    await conn.reducers.createGroupThread({
      agentDbId: actor.id,
      participantPublicIdentities,
      membershipLocked: params.locked,
      title: params.title?.trim() || undefined,
    });

    const thread = await waitForThread({
      read,
      predicate: nextSnapshot =>
        nextSnapshot.threads.find(row => {
          return (
            row.kind === 'group' &&
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
      locked: thread.membershipLocked,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const read = () => readLatestMessageRows(conn);
    const snapshot = await read();
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);
    const targetLookup = await resolvePublishedActorLookup({
      identifier: params.participant,
      lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
      lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
      invalidMessage: 'Participant slug or email is invalid.',
      invalidCode: 'INVALID_AGENT_IDENTIFIER',
      notFoundCode: 'ACTOR_NOT_FOUND',
      fallbackMessage: 'Unable to resolve participant slug or email.',
    });
    const target = targetLookup.selected;

    await conn.reducers.addThreadParticipant({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      participantPublicIdentity: target.publicIdentity,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);

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
      participantAgentDbId: targetActor.id,
    });

    const nextSnapshot = await readLatestMessageRows(conn);
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
  throughSeq?: string;
  reporter: TaskReporter;
}): Promise<ThreadReadResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    const thread = requireThread(snapshot, requestedThreadId);
    requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);

    const throughSeq = params.throughSeq ? parseThreadId(params.throughSeq) : thread.lastMessageSeq;
    await conn.reducers.markThreadRead({
      agentDbId: actor.id,
      threadId: requestedThreadId,
      upToThreadSeq: throughSeq,
    });

    return {
      profile: profile.name,
      actorSlug: actor.slug,
      threadId: thread.id.toString(),
      label: thread.title?.trim() || `Thread ${thread.id.toString()}`,
      throughSeq: throughSeq.toString(),
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    const thread = requireThread(snapshot, requestedThreadId);
    requireActiveThreadParticipant(snapshot, requestedThreadId, actor.id);

    await conn.reducers.setThreadArchived({
      agentDbId: actor.id,
      threadId: requestedThreadId,
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
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
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
    const snapshot = await readLatestMessageRows(conn);
    const actor = resolveOwnedActor({
      snapshot,
      normalizedEmail,
      actorSlug: params.actorSlug,
      threadId: requestedThreadId,
    });
    const thread = requireThread(snapshot, requestedThreadId);

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
