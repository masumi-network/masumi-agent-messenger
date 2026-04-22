import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleContactRequestRow,
  normalizeContactRequestStatus,
  getRequiredInboxById,
  getRequiredActorByPublicIdentity,
  getRequiredContactRequestByRowId,
  getReadableInbox,
  getOwnedActor,
  findPendingContactRequestForActors,
  isDirectContactAllowed,
  toVisibleContactRequestRow,
  getVisibleContactRequestsForInbox,
  deleteThreadAndDependents,
  createDirectThreadRecord,
} = model;
export const visibleContactRequests = spacetimedb.view(
  { public: true },
  t.array(VisibleContactRequestRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getVisibleContactRequestsForInbox(ctx, inbox.id)
      .map(request => toVisibleContactRequestRow(ctx, inbox.id, request));
  }
);

export const approveContactRequest = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
  },
  (ctx, { agentDbId, requestId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const request = getRequiredContactRequestByRowId(ctx, requestId);
    if (request.targetAgentDbId !== actor.id) {
      throw new SenderError('Only the target inbox slug may approve this contact request');
    }
    if (request.status.tag !== 'pending') {
      throw new SenderError('Only pending contact requests can be approved');
    }

    ctx.db.contactRequest.id.update({
      ...request,
      status: normalizeContactRequestStatus('approved'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: actor.id,
    });
  }
);

export const rejectContactRequest = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
  },
  (ctx, { agentDbId, requestId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const request = getRequiredContactRequestByRowId(ctx, requestId);
    if (request.targetAgentDbId !== actor.id) {
      throw new SenderError('Only the target inbox slug may reject this contact request');
    }
    if (request.status.tag !== 'pending') {
      throw new SenderError('Only pending contact requests can be rejected');
    }

    ctx.db.contactRequest.id.update({
      ...request,
      status: normalizeContactRequestStatus('rejected'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: actor.id,
    });
    deleteThreadAndDependents(ctx, request.threadId, { preserveContactRequests: true });
  }
);

export const createPendingDirectContactRequest = spacetimedb.reducer(
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
    if (isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError('Direct contact is already allowed for this actor pair');
    }
    if (findPendingContactRequestForActors(ctx, actor, otherActor)) {
      throw new SenderError('A pending contact request already exists for this actor pair');
    }

    const requesterInbox = getRequiredInboxById(ctx, actor.inboxId);
    const thread = createDirectThreadRecord(ctx, actor, otherActor, {
      membershipLocked,
      title,
    });

    ctx.db.contactRequest.insert({
      id: 0n,
      threadId: thread.id,
      requesterAgentDbId: actor.id,
      requesterPublicIdentity: actor.publicIdentity,
      requesterSlug: actor.slug,
      requesterDisplayName: actor.displayName,
      requesterNormalizedEmail: requesterInbox.normalizedEmail,
      requesterDisplayEmail: requesterInbox.displayEmail,
      targetAgentDbId: otherActor.id,
      targetPublicIdentity: otherActor.publicIdentity,
      targetSlug: otherActor.slug,
      targetDisplayName: otherActor.displayName,
      status: normalizeContactRequestStatus('pending'),
      hiddenMessageCount: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
  }
);
