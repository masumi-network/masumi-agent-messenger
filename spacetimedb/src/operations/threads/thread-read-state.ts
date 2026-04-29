import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleThreadReadStateRow,
  buildThreadParticipantKey,
  buildThreadReadStateKey,
  getOwnActorIdsForInbox,
  getReadableInbox,
  getOwnedActor,
  buildLatestVisibleThreadIdsForInbox,
  requireVisibleThreadParticipant,
  getThreadReadStateForActor,
  isThreadVisibleInNormalViews,
} = model;
export const visibleThreadReadStates = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadReadStateRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = getOwnActorIdsForInbox(ctx, inbox.id);
    const visibleThreadIds = buildLatestVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(ownActorIds).flatMap(agentDbId =>
      Array.from(ctx.db.threadReadState.thread_read_state_agent_db_id.filter(agentDbId)).filter(
        readState => visibleThreadIds.has(readState.threadId)
      )
    );
  }
);

export const markThreadRead = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    upToThreadSeq: t.u64().optional(),
  },
  (ctx, { agentDbId, threadId, upToThreadSeq }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');

    requireVisibleThreadParticipant(ctx, threadId, actor.id);

    const nextLastReadThreadSeq = upToThreadSeq ?? thread.lastMessageSeq;
    if (nextLastReadThreadSeq > thread.lastMessageSeq) {
      throw new SenderError('upToThreadSeq exceeds the current thread sequence');
    }

    let readState = getThreadReadStateForActor(ctx, threadId, actor.id);
    if (!readState) {
      readState = ctx.db.threadReadState.insert({
        id: 0n,
        threadId,
        agentDbId: actor.id,
        uniqueKey: buildThreadReadStateKey(threadId, actor.id),
        lastReadThreadSeq: undefined,
        archived: false,
        updatedAt: ctx.timestamp,
      });
    }

    if (
      readState.lastReadThreadSeq !== undefined &&
      nextLastReadThreadSeq <= readState.lastReadThreadSeq
    ) {
      return;
    }

    ctx.db.threadReadState.id.update({
      ...readState,
      lastReadThreadSeq: nextLastReadThreadSeq,
      updatedAt: ctx.timestamp,
    });
  }
);

export const repairOwnSenderReadStates = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
  },
  (ctx, { agentDbId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const latestSentSeqByThreadId = new Map<bigint, bigint>();

    for (const message of ctx.db.message.message_sender_agent_db_id.filter(actor.id)) {
      const participant = ctx.db.threadParticipant.uniqueKey.find(
        buildThreadParticipantKey(message.threadId, actor.id)
      );
      if (!participant || !isThreadVisibleInNormalViews(ctx, message.threadId)) {
        continue;
      }
      const current = latestSentSeqByThreadId.get(message.threadId) ?? 0n;
      if (message.threadSeq > current) {
        latestSentSeqByThreadId.set(message.threadId, message.threadSeq);
      }
    }

    for (const [threadId, lastReadThreadSeq] of latestSentSeqByThreadId) {
      const readState = getThreadReadStateForActor(ctx, threadId, actor.id);
      if (!readState) {
        ctx.db.threadReadState.insert({
          id: 0n,
          threadId,
          agentDbId: actor.id,
          uniqueKey: buildThreadReadStateKey(threadId, actor.id),
          lastReadThreadSeq,
          archived: false,
          updatedAt: ctx.timestamp,
        });
        continue;
      }

      if (
        readState.lastReadThreadSeq === undefined ||
        readState.lastReadThreadSeq < lastReadThreadSeq
      ) {
        ctx.db.threadReadState.id.update({
          ...readState,
          lastReadThreadSeq,
          updatedAt: ctx.timestamp,
        });
      }
    }
  }
);

export const setThreadArchived = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    archived: t.bool(),
  },
  (ctx, { agentDbId, threadId, archived }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    if (!ctx.db.thread.id.find(threadId)) throw new SenderError('Thread not found');
    requireVisibleThreadParticipant(ctx, threadId, actor.id);

    const existingReadState = getThreadReadStateForActor(ctx, threadId, actor.id);

    if (!existingReadState) {
      ctx.db.threadReadState.insert({
        id: 0n,
        threadId,
        agentDbId: actor.id,
        uniqueKey: buildThreadReadStateKey(threadId, actor.id),
        lastReadThreadSeq: undefined,
        archived,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.threadReadState.id.update({
      ...existingReadState,
      archived,
      updatedAt: ctx.timestamp,
    });
  }
);
