import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleThreadInviteRow,
  dedupeRowsById,
  getOwnActorIdsForInbox,
  getRequiredThreadInviteByRowId,
  getReadableInbox,
  getOwnedActor,
  toVisibleThreadInviteRow,
  resolveThreadInvite,
  ensureThreadParticipant,
} = model;
export const visibleThreadInvites = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadInviteRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const incomingInvites = Array.from(
      ctx.db.threadInvite.thread_invite_invitee_inbox_id.filter(inbox.id)
    );
    const outgoingInvites = Array.from(getOwnActorIdsForInbox(ctx, inbox.id)).flatMap(agentDbId =>
      Array.from(ctx.db.threadInvite.thread_invite_inviter_agent_db_id.filter(agentDbId))
    );

    return dedupeRowsById([...incomingInvites, ...outgoingInvites])
      .map(invite => toVisibleThreadInviteRow(ctx, invite));
  }
);

export const acceptThreadInvite = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    inviteId: t.u64(),
  },
  (ctx, { agentDbId, inviteId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const invite = getRequiredThreadInviteByRowId(ctx, inviteId);
    if (invite.inviteeAgentDbId !== actor.id) {
      throw new SenderError('Only the invited agent may accept this thread invite');
    }
    if (invite.status !== 'pending') {
      throw new SenderError('Only pending thread invites can be accepted');
    }

    const thread = ctx.db.thread.id.find(invite.threadId);
    if (!thread) throw new SenderError('Thread not found');

    const membershipChanged = ensureThreadParticipant(ctx, thread.id, actor);
    resolveThreadInvite(ctx, invite, 'accepted', actor.id);

    if (membershipChanged) {
      ctx.db.thread.id.update({
        ...thread,
        membershipVersion: thread.membershipVersion + 1n,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const rejectThreadInvite = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    inviteId: t.u64(),
  },
  (ctx, { agentDbId, inviteId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const invite = getRequiredThreadInviteByRowId(ctx, inviteId);
    if (invite.inviteeAgentDbId !== actor.id) {
      throw new SenderError('Only the invited agent may reject this thread invite');
    }
    if (invite.status !== 'pending') {
      throw new SenderError('Only pending thread invites can be rejected');
    }

    resolveThreadInvite(ctx, invite, 'rejected', actor.id);
  }
);
