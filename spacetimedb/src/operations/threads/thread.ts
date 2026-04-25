import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_THREAD_FANOUT,
  MAX_VISIBLE_THREAD_PAGE_SIZE,
  VisibleThreadPage,
  VisibleThreadRow,
  normalizePublicIdentity,
  normalizeOptionalThreadTitle,
  requireMaxArrayLength,
  getRequiredActorByPublicIdentity,
  getReadableInbox,
  getOwnedActor,
  getOwnedActorForRead,
  getOwnActorIdsForInbox,
  getContactRequestByThreadId,
  isDirectContactAllowed,
  getLatestVisibleThreadsForInbox,
  getVisibleInboxThreadPageRows,
  ensureInboxThreadProjectionsForInbox,
  toSanitizedVisibleAgentRow,
  requireVisibleThreadParticipant,
  ensureThreadInvite,
  deleteThreadAndDependents,
  buildGroupKey,
  createDirectThreadRecord,
  ensureThreadParticipant,
  requireAdminThreadParticipant,
} = model;

function normalizeThreadPageLimit(limit: bigint) {
  if (limit === 0n) {
    throw new SenderError('limit is required and must be greater than zero');
  }
  return limit > BigInt(MAX_VISIBLE_THREAD_PAGE_SIZE)
    ? MAX_VISIBLE_THREAD_PAGE_SIZE
    : Number(limit);
}

function normalizeThreadPageFilter(filter: string | undefined) {
  if (
    filter === undefined ||
    filter === 'active' ||
    filter === 'latest' ||
    filter === 'archived' ||
    filter === 'all'
  ) {
    return filter ?? 'active';
  }
  throw new SenderError('thread filter must be active, latest, archived, or all');
}

function toVisibleThreadRow(thread: model.ThreadRow) {
  return {
    id: thread.id,
    dedupeKey: thread.dedupeKey,
    kind: thread.kind,
    membershipLocked: thread.membershipLocked,
    title: thread.title,
    creatorAgentDbId: thread.creatorAgentDbId,
    membershipVersion: thread.membershipVersion,
    nextThreadSeq: thread.nextThreadSeq,
    lastMessageSeq: thread.lastMessageSeq,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastMessageAt: thread.lastMessageAt,
  };
}

function threadMatchesSearch(tx: model.ReadDbCtx, thread: model.ThreadRow, query: string) {
  if (!query) {
    return true;
  }
  if (thread.title?.toLowerCase().includes(query) || thread.dedupeKey.toLowerCase().includes(query)) {
    return true;
  }

  return Array.from(tx.db.threadParticipant.thread_participant_thread_id.filter(thread.id)).some(
    participant => {
      const actor = tx.db.agent.id.find(participant.agentDbId);
      return Boolean(
        actor &&
          [actor.slug, actor.displayName ?? '', actor.publicIdentity]
            .join(' ')
            .toLowerCase()
            .includes(query)
      );
    }
  );
}

function threadMatchesFilter(
  tx: model.ReadDbCtx,
  thread: model.ThreadRow,
  agentDbId: bigint,
  filter: 'active' | 'latest' | 'archived' | 'all'
) {
  if (filter === 'all') return true;

  const readState = tx.db.threadReadState.uniqueKey.find(
    `${thread.id.toString()}:${agentDbId.toString()}`
  );
  const archived = readState?.archived ?? false;
  const lastReadThreadSeq = readState?.lastReadThreadSeq ?? 0n;
  const unreadCount =
    thread.lastMessageSeq > lastReadThreadSeq ? thread.lastMessageSeq - lastReadThreadSeq : 0n;

  if (filter === 'active') return !archived;
  if (filter === 'latest') return !archived && unreadCount > 0n;
  return archived;
}

function buildVisibleThreadPage(
  tx: model.ReadDbCtx,
  inboxId: bigint,
  threads: model.ThreadRow[],
  nextAfterSortKey: string | undefined
) {
  const threadIds = new Set(threads.map(thread => thread.id));
  const ownActorIds = getOwnActorIdsForInbox(tx, inboxId);
  const participants = threads.flatMap(thread =>
    Array.from(tx.db.threadParticipant.thread_participant_thread_id.filter(thread.id))
      .map(participant => ({
        id: participant.id,
        threadId: participant.threadId,
        agentDbId: participant.agentDbId,
        joinedAt: participant.joinedAt,
        lastSentSeq: participant.lastSentSeq,
        lastSentMembershipVersion: participant.lastSentMembershipVersion,
        lastSentSecretVersion: participant.lastSentSecretVersion,
        isAdmin: participant.isAdmin,
        active: participant.active,
      }))
  );
  const actorIds = new Set<bigint>(ownActorIds);
  for (const participant of participants) {
    actorIds.add(participant.agentDbId);
  }

  return {
    actors: Array.from(actorIds)
      .map(agentDbId => tx.db.agent.id.find(agentDbId))
      .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor))
      .map(actor => toSanitizedVisibleAgentRow(tx, inboxId, actor)),
    bundles: Array.from(actorIds).flatMap(agentDbId =>
      Array.from(tx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(agentDbId)).map(
        bundle => ({
          id: bundle.id,
          agentDbId: bundle.agentDbId,
          publicIdentity: bundle.publicIdentity,
          encryptionPublicKey: bundle.encryptionPublicKey,
          encryptionKeyVersion: bundle.encryptionKeyVersion,
          encryptionAlgorithm: bundle.encryptionAlgorithm,
          signingPublicKey: bundle.signingPublicKey,
          signingKeyVersion: bundle.signingKeyVersion,
          signingAlgorithm: bundle.signingAlgorithm,
          createdAt: bundle.createdAt,
        })
      )
    ),
    participants,
    readStates: Array.from(ownActorIds).flatMap(agentDbId =>
      Array.from(tx.db.threadReadState.thread_read_state_agent_db_id.filter(agentDbId))
        .filter(readState => threadIds.has(readState.threadId))
        .map(readState => ({
          id: readState.id,
          threadId: readState.threadId,
          agentDbId: readState.agentDbId,
          lastReadThreadSeq: readState.lastReadThreadSeq,
          archived: readState.archived,
          updatedAt: readState.updatedAt,
        }))
    ),
    threads: threads.map(toVisibleThreadRow),
    nextAfterSortKey,
  };
}

export const visibleThreads = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getLatestVisibleThreadsForInbox(ctx, inbox.id).map(toVisibleThreadRow);
  }
);

export const listVisibleThreads = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    afterSortKey: t.string().optional(),
    filter: t.string().optional(),
    query: t.string().optional(),
    limit: t.u64(),
  },
  VisibleThreadPage,
  (ctx, { agentDbId, afterSortKey, filter, query, limit }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      ensureInboxThreadProjectionsForInbox(tx, actor.inboxId);
      const pageSize = normalizeThreadPageLimit(limit);
      const threadFilter = normalizeThreadPageFilter(filter);
      const normalizedQuery = query?.trim().toLowerCase() ?? '';
      const pageRows = getVisibleInboxThreadPageRows(
        tx,
        actor.inboxId,
        afterSortKey,
        pageSize,
        (_row, thread) =>
          threadMatchesFilter(tx, thread, actor.id, threadFilter) &&
          threadMatchesSearch(tx, thread, normalizedQuery)
      );
      const threads = pageRows
        .map(row => tx.db.thread.id.find(row.threadId))
        .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));

      return buildVisibleThreadPage(
        tx,
        actor.inboxId,
        threads,
        pageRows.length >= pageSize ? pageRows[pageRows.length - 1]?.sortKey : undefined
      );
    });
  }
);

export const readVisibleThread = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
  },
  VisibleThreadPage,
  (ctx, { agentDbId, threadId }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      ensureInboxThreadProjectionsForInbox(tx, actor.inboxId);
      const thread = tx.db.thread.id.find(threadId);
      if (!thread) {
        throw new SenderError('Thread not found');
      }
      requireVisibleThreadParticipant(tx, thread.id, actor.id);
      return buildVisibleThreadPage(tx, actor.inboxId, [thread], undefined);
    });
  }
);

export const createDirectThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    otherAgentPublicIdentity: t.string(),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
  },
  (ctx, { agentDbId, otherAgentPublicIdentity, membershipLocked, title }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const otherActor = getRequiredActorByPublicIdentity(ctx, otherAgentPublicIdentity);

    if (actor.id === otherActor.id) {
      throw new SenderError('Direct threads require a second actor');
    }
    if (!isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError(
        'Direct contact requires approval for first contact. Send a first message to create a contact request.'
      );
    }

    createDirectThreadRecord(ctx, actor, otherActor, {
      membershipLocked,
      title,
    });
  }
);

export const createGroupThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    participantPublicIdentities: t.array(t.string()),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
  },
  (ctx, { agentDbId, participantPublicIdentities, membershipLocked, title }) => {
    requireMaxArrayLength(
      participantPublicIdentities,
      MAX_THREAD_FANOUT,
      'participantPublicIdentities'
    );

    const actor = getOwnedActor(ctx, agentDbId);

    const allParticipantPublicIdentities = Array.from(
      new Set([actor.publicIdentity, ...participantPublicIdentities.map(normalizePublicIdentity)])
    );
    if (allParticipantPublicIdentities.length < 2) {
      throw new SenderError('Group threads require at least one participant besides the creator');
    }
    if (allParticipantPublicIdentities.length > MAX_THREAD_FANOUT) {
      throw new SenderError(
        `Threads may include at most ${MAX_THREAD_FANOUT.toString()} active or pending participants`
      );
    }

    const participants = allParticipantPublicIdentities.map(participantPublicIdentity =>
      getRequiredActorByPublicIdentity(ctx, participantPublicIdentity)
    );

    const groupKey = buildGroupKey(actor, ctx.timestamp.microsSinceUnixEpoch);
    const thread = ctx.db.thread.insert({
        id: 0n,
        dedupeKey: groupKey,
        kind: 'group',
        membershipLocked: membershipLocked ?? false,
        title: normalizeOptionalThreadTitle(title),
        creatorAgentDbId: actor.id,
        membershipVersion: 1n,
        nextThreadSeq: 1n,
      lastMessageSeq: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastMessageAt: ctx.timestamp,
    });

    for (const participant of participants) {
      if (participant.id === actor.id) {
        ensureThreadParticipant(ctx, thread.id, participant, { isAdmin: true });
      } else if (isDirectContactAllowed(ctx, actor, participant)) {
        ensureThreadParticipant(ctx, thread.id, participant);
      } else {
        ensureThreadInvite(ctx, thread.id, actor, participant);
      }
    }
  }
);

export const deleteThread = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
  },
  (ctx, { agentDbId, threadId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');

    requireAdminThreadParticipant(ctx, threadId, actor.id);

    const request = getContactRequestByThreadId(ctx, threadId);
    if (request && request.status.tag === 'pending') {
      throw new SenderError('Cannot delete a thread with a pending contact request — reject it first');
    }

    deleteThreadAndDependents(ctx, threadId);
  }
);
