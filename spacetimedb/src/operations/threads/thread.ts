import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_THREAD_FANOUT,
  VisibleThreadRow,
  normalizePublicIdentity,
  normalizeOptionalThreadTitle,
  requireMaxArrayLength,
  getRequiredActorByPublicIdentity,
  getReadableInbox,
  getOwnedActor,
  getContactRequestByThreadId,
  isDirectContactAllowed,
  buildVisibleThreadIdsForInbox,
  ensureThreadInvite,
  deleteThreadAndDependents,
  buildGroupKey,
  createDirectThreadRecord,
  ensureThreadParticipant,
  requireAdminThreadParticipant,
} = model;
export const visibleThreads = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(visibleThreadIds)
      .map(threadId => ctx.db.thread.id.find(threadId))
      .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
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
