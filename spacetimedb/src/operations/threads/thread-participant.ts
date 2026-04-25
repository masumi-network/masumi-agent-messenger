import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleThreadParticipantRow,
  buildThreadInviteKey,
  getRequiredActorByPublicIdentity,
  getReadableInbox,
  getOwnedActor,
  isDirectContactAllowed,
  requirePendingDirectContactResolvedForThreadMutation,
  buildLatestVisibleThreadIdsForInbox,
  getThreadParticipants,
  getActiveThreadParticipants,
  requireThreadFanoutCapacity,
  ensureThreadInvite,
  resolveThreadInvite,
  ensureThreadParticipant,
  requireActiveThreadParticipant,
  requireAdminThreadParticipant,
  promoteReplacementAdmin,
} = model;
export const visibleThreadParticipants = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadParticipantRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildLatestVisibleThreadIdsForInbox(ctx, inbox.id))
      .flatMap(threadId =>
        Array.from(ctx.db.threadParticipant.thread_participant_thread_id.filter(threadId))
      )
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
      }));
  }
);

export const addThreadParticipant = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantPublicIdentity: t.string(),
  },
  (ctx, { agentDbId, threadId, participantPublicIdentity }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    if (thread.membershipLocked) {
      throw new SenderError('Locked threads cannot add new participants');
    }
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);

    requireAdminThreadParticipant(ctx, threadId, actor.id);
    const participantActor = getRequiredActorByPublicIdentity(ctx, participantPublicIdentity);
    if (participantActor.id === actor.id) {
      return;
    }

    const existingParticipant = getThreadParticipants(ctx, threadId).find(participant => {
      return participant.agentDbId === participantActor.id;
    });
    const existingInvite = ctx.db.threadInvite.uniqueKey.find(
      buildThreadInviteKey(threadId, participantActor.id)
    );
    const directContactAllowed = isDirectContactAllowed(ctx, actor, participantActor);

    let membershipChanged = false;
    let inviteChanged = false;
    if (directContactAllowed) {
      if (!existingParticipant?.active && !existingInvite) {
        requireThreadFanoutCapacity(ctx, threadId);
      }
      membershipChanged = ensureThreadParticipant(ctx, threadId, participantActor);
      if (existingInvite?.status === 'pending') {
        resolveThreadInvite(ctx, existingInvite, 'accepted', actor.id);
      }
    } else {
      inviteChanged = ensureThreadInvite(ctx, threadId, actor, participantActor);
    }

    const activeParticipantCount = getActiveThreadParticipants(ctx, threadId).length;
    const kindTransition =
      thread.kind !== 'group' && (activeParticipantCount > 2 || inviteChanged);
    if (membershipChanged || kindTransition) {
      ctx.db.thread.id.update({
        ...thread,
        kind: kindTransition ? 'group' : thread.kind,
        membershipVersion: membershipChanged
          ? thread.membershipVersion + 1n
          : thread.membershipVersion,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const removeThreadParticipant = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantAgentDbId: t.u64(),
  },
  (ctx, { agentDbId, threadId, participantAgentDbId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);
    const participant = getThreadParticipants(ctx, threadId).find(row => {
      return row.agentDbId === participantAgentDbId;
    });
    if (!participant || !participant.active) {
      throw new SenderError('Participant is not active in this thread');
    }

    if (thread.membershipLocked && actor.id !== participantAgentDbId) {
      throw new SenderError('Locked threads only allow participants to leave themselves');
    }

    if (actor.id !== participantAgentDbId) {
      requireAdminThreadParticipant(ctx, threadId, actor.id);
    } else {
      requireActiveThreadParticipant(ctx, threadId, actor.id);
    }

    ctx.db.threadParticipant.id.update({
      ...participant,
      active: false,
      isAdmin: false,
    });

      promoteReplacementAdmin(ctx, threadId);
      ctx.db.thread.id.update({
        ...thread,
        membershipVersion: thread.membershipVersion + 1n,
        updatedAt: ctx.timestamp,
      });
    }
);

export const setThreadParticipantAdmin = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    participantAgentDbId: t.u64(),
    isAdmin: t.bool(),
  },
  (ctx, { agentDbId, threadId, participantAgentDbId, isAdmin }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);
    requireAdminThreadParticipant(ctx, threadId, actor.id);

    const participant = getActiveThreadParticipants(ctx, threadId).find(row => {
      return row.agentDbId === participantAgentDbId;
    });
    if (!participant) {
      throw new SenderError('Participant is not active in this thread');
    }

    ctx.db.threadParticipant.id.update({
      ...participant,
      isAdmin,
    });

    promoteReplacementAdmin(ctx, threadId);
  }
);
