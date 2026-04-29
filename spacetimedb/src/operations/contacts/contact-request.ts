import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  CONTACT_RESOLVE_RATE_WINDOW_MS,
  CONTACT_RESOLVE_RATE_MAX_PER_WINDOW,
  VisibleContactRequestRow,
  enforceRateLimit,
  normalizeContactRequestStatus,
  getRequiredContactRequestByRowId,
  getReadableInbox,
  getOwnedActor,
  toVisibleContactRequestRow,
  getVisibleContactRequestsForInbox,
  deleteThreadAndDependents,
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
    const resolveAllowed = enforceRateLimit(ctx, {
      bucketKey: `contact_resolve:${ctx.sender.toHexString()}:${actor.id.toString()}`,
      action: 'contact_resolve',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: CONTACT_RESOLVE_RATE_WINDOW_MS,
      maxCount: CONTACT_RESOLVE_RATE_MAX_PER_WINDOW,
    });
    if (!resolveAllowed) {
      throw new SenderError('Contact resolve rate limit exceeded; try again later');
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
    const resolveAllowed = enforceRateLimit(ctx, {
      bucketKey: `contact_resolve:${ctx.sender.toHexString()}:${actor.id.toString()}`,
      action: 'contact_resolve',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: CONTACT_RESOLVE_RATE_WINDOW_MS,
      maxCount: CONTACT_RESOLVE_RATE_MAX_PER_WINDOW,
    });
    if (!resolveAllowed) {
      throw new SenderError('Contact resolve rate limit exceeded; try again later');
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
