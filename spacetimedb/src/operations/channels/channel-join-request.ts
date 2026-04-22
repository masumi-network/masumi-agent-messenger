import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleChannelJoinRequestRow,
  enforceRateLimit,
  enforceChannelAdminRateLimit,
  normalizeChannelPermission,
  normalizeChannelJoinRequestStatus,
  dedupeRowsById,
  buildChannelJoinRequestKey,
  getOwnActorIdsForInbox,
  getRequiredActorByDbId,
  getRequiredChannelById,
  resolveRequiredChannel,
  getRequiredChannelJoinRequestByRowId,
  getReadableInbox,
  getOwnedActor,
  getActiveChannelMember,
  requireAdminChannelMember,
  ensureChannelMember,
} = model;

export const visibleChannelJoinRequests = spacetimedb.view(
  { public: true },
  t.array(VisibleChannelJoinRequestRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = getOwnActorIdsForInbox(ctx, inbox.id);
    const adminChannelIds = new Set(
      Array.from(ctx.db.channelMember.channel_member_inbox_id.filter(inbox.id))
        .filter(member => member.active && member.permission === 'admin')
        .map(member => member.channelId)
    );
    const requests = dedupeRowsById([
      ...Array.from(ctx.db.channelJoinRequest.channel_join_request_requester_inbox_id.filter(inbox.id)),
      ...Array.from(adminChannelIds).flatMap(channelId =>
        Array.from(
          ctx.db.channelJoinRequest.channel_join_request_channel_id.filter(channelId)
        )
      ),
    ]);

    return requests.map(request => {
      const channel = getRequiredChannelById(ctx, request.channelId);
      const requester = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
      return {
        id: request.id,
        channelId: request.channelId,
        channelSlug: channel.slug,
        channelTitle: channel.title,
        requesterAgentDbId: request.requesterAgentDbId,
        requesterPublicIdentity: requester.publicIdentity,
        requesterSlug: requester.slug,
        requesterDisplayName: requester.displayName,
        requesterCurrentEncryptionPublicKey: requester.currentEncryptionPublicKey,
        requesterCurrentEncryptionKeyVersion: requester.currentEncryptionKeyVersion,
        permission: request.permission,
        status: request.status,
        direction: ownActorIds.has(request.requesterAgentDbId) ? 'outgoing' : 'incoming',
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        resolvedAt: request.resolvedAt,
        resolvedByAgentDbId: request.resolvedByAgentDbId,
      };
    });
  }
);

export const requestChannelJoin = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    permission: t.string().optional(),
  },
  (ctx, { agentDbId, channelId, channelSlug, permission }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const channel = resolveRequiredChannel(ctx, { channelId, channelSlug });
    if (channel.accessMode !== 'approval_required') {
      throw new SenderError('Only approval-required channels need join requests');
    }
    if (getActiveChannelMember(ctx, channel.id, actor.id)) {
      throw new SenderError('Actor is already a channel member');
    }
    const allowed = enforceRateLimit(ctx, {
      bucketKey: `channel_join_request:${ctx.sender.toHexString()}:${channel.id.toString()}`,
      action: 'channel_join_request',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: model.CHANNEL_JOIN_REQUEST_RATE_WINDOW_MS,
      maxCount: model.CHANNEL_JOIN_REQUEST_RATE_MAX_PER_WINDOW,
    });
    if (!allowed) {
      throw new SenderError('Too many channel join requests; try again later');
    }

    const requestedPermission = normalizeChannelPermission(permission ?? 'read', {
      allowAdmin: false,
    });
    const uniqueKey = buildChannelJoinRequestKey(channel.id, actor.id);
    const existing = ctx.db.channelJoinRequest.uniqueKey.find(uniqueKey);
    if (!existing) {
      ctx.db.channelJoinRequest.insert({
        id: 0n,
        channelId: channel.id,
        requesterAgentDbId: actor.id,
        requesterInboxId: actor.inboxId,
        uniqueKey,
        permission: requestedPermission,
        status: normalizeChannelJoinRequestStatus('pending'),
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
        resolvedAt: undefined,
        resolvedByAgentDbId: undefined,
      });
      return;
    }

    if (existing.status === 'pending') {
      throw new SenderError('A pending channel join request already exists');
    }
    ctx.db.channelJoinRequest.id.update({
      ...existing,
      requesterInboxId: actor.inboxId,
      permission: requestedPermission,
      status: normalizeChannelJoinRequestStatus('pending'),
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
  }
);

export const approveChannelJoin = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
    permission: t.string().optional(),
  },
  (ctx, { agentDbId, requestId, permission }) => {
    const adminAgent = getOwnedActor(ctx, agentDbId);
    const request = getRequiredChannelJoinRequestByRowId(ctx, requestId);
    const channel = getRequiredChannelById(ctx, request.channelId);
    requireAdminChannelMember(ctx, channel.id, adminAgent.id);
    enforceChannelAdminRateLimit(ctx, channel.id);
    if (channel.accessMode !== 'approval_required') {
      throw new SenderError('Only approval-required channels use join approvals');
    }
    if (request.status !== 'pending') {
      throw new SenderError('Only pending channel join requests can be approved');
    }
    const requester = getRequiredActorByDbId(ctx, request.requesterAgentDbId);
    const grantedPermission = normalizeChannelPermission(permission ?? request.permission, {
      allowAdmin: false,
    });
    ensureChannelMember(ctx, channel, requester, grantedPermission);
    ctx.db.channelJoinRequest.id.update({
      ...request,
      permission: grantedPermission,
      status: normalizeChannelJoinRequestStatus('approved'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: adminAgent.id,
    });
  }
);

export const rejectChannelJoin = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    requestId: t.u64(),
  },
  (ctx, { agentDbId, requestId }) => {
    const adminAgent = getOwnedActor(ctx, agentDbId);
    const request = getRequiredChannelJoinRequestByRowId(ctx, requestId);
    requireAdminChannelMember(ctx, request.channelId, adminAgent.id);
    enforceChannelAdminRateLimit(ctx, request.channelId);
    if (request.status !== 'pending') {
      throw new SenderError('Only pending channel join requests can be rejected');
    }
    ctx.db.channelJoinRequest.id.update({
      ...request,
      status: normalizeChannelJoinRequestStatus('rejected'),
      updatedAt: ctx.timestamp,
      resolvedAt: ctx.timestamp,
      resolvedByAgentDbId: adminAgent.id,
    });
  }
);
