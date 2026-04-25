import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_CHANNEL_MEMBER_PAGE_SIZE,
  VisibleChannelMembershipRow,
  ChannelMemberListRowSchema,
  enforceRateLimit,
  enforceChannelAdminRateLimit,
  normalizeChannelPermission,
  normalizePublicChannelJoinPermission,
  getRequiredActorByDbId,
  resolveRequiredChannel,
  getReadableInbox,
  getOwnedActor,
  getOwnedActorForRead,
  getChannelMemberPageById,
  requireActiveChannelMember,
  requireAdminChannelMember,
  ensureChannelMember,
  requireAnotherActiveChannelAdmin,
} = model;
type ChannelMemberListResultRow = model.ChannelMemberListResultRow;

export const visibleChannelMemberships = spacetimedb.view(
  { public: true },
  t.array(VisibleChannelMembershipRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(ctx.db.channelMember.channel_member_inbox_id.filter(inbox.id)).map(
      member => ({
        id: member.id,
        channelId: member.channelId,
        agentDbId: member.agentDbId,
        permission: member.permission,
        active: member.active,
        lastSentSeq: member.lastSentSeq,
        joinedAt: member.joinedAt,
        updatedAt: member.updatedAt,
      })
    );
  }
);

export const listChannelMembers = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    afterMemberId: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(ChannelMemberListRowSchema),
  (ctx, { agentDbId, channelId, channelSlug, afterMemberId, limit }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const channel = resolveRequiredChannel(tx, { channelId, channelSlug });
      requireActiveChannelMember(tx, channel.id, actor.id);

      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_CHANNEL_MEMBER_PAGE_SIZE)
          ? MAX_CHANNEL_MEMBER_PAGE_SIZE
          : Number(limit);
      const lowerBound = afterMemberId ?? 0n;

      const rows: ChannelMemberListResultRow[] = [];
      const members = getChannelMemberPageById(tx, channel.id, lowerBound, pageSize);

      for (const member of members) {
        const memberActor = getRequiredActorByDbId(tx, member.agentDbId);
        rows.push({
          id: member.id,
          channelId: member.channelId,
          agentDbId: member.agentDbId,
          agentPublicIdentity: memberActor.publicIdentity,
          agentSlug: memberActor.slug,
          agentDisplayName: memberActor.displayName,
          agentCurrentEncryptionPublicKey: memberActor.currentEncryptionPublicKey,
          agentCurrentEncryptionKeyVersion: memberActor.currentEncryptionKeyVersion,
          permission: member.permission,
          active: member.active,
          lastSentSeq: member.lastSentSeq,
          joinedAt: member.joinedAt,
          updatedAt: member.updatedAt,
        });
      }
      return rows;
    });
  }
);

export const joinPublicChannel = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
  },
  (ctx, { agentDbId, channelId, channelSlug }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const channel = resolveRequiredChannel(ctx, { channelId, channelSlug });
    if (channel.accessMode !== 'public') {
      throw new SenderError('Only public channels can be joined directly');
    }
    const allowed = enforceRateLimit(ctx, {
      bucketKey: `channel_join:${ctx.sender.toHexString()}`,
      action: 'channel_join',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: model.CHANNEL_JOIN_RATE_WINDOW_MS,
      maxCount: model.CHANNEL_JOIN_RATE_MAX_PER_WINDOW,
    });
    if (!allowed) {
      throw new SenderError('Too many channel joins; try again later');
    }
    ensureChannelMember(
      ctx,
      channel,
      actor,
      normalizePublicChannelJoinPermission(channel.publicJoinPermission)
    );
  }
);

export const setChannelMemberPermission = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64(),
    memberAgentDbId: t.u64(),
    permission: t.string(),
  },
  (ctx, { agentDbId, channelId, memberAgentDbId, permission }) => {
    const adminAgent = getOwnedActor(ctx, agentDbId);
    requireAdminChannelMember(ctx, channelId, adminAgent.id);
    enforceChannelAdminRateLimit(ctx, channelId);
    const member = requireActiveChannelMember(ctx, channelId, memberAgentDbId);
    const normalizedPermission = normalizeChannelPermission(permission);
    if (member.permission === 'admin' && normalizedPermission !== 'admin') {
      requireAnotherActiveChannelAdmin(ctx, channelId, member.agentDbId);
    }
    ctx.db.channelMember.id.update({
      ...member,
      permission: normalizedPermission,
      updatedAt: ctx.timestamp,
    });
  }
);

export const removeChannelMember = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64(),
    memberAgentDbId: t.u64(),
  },
  (ctx, { agentDbId, channelId, memberAgentDbId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    if (actor.id !== memberAgentDbId) {
      requireAdminChannelMember(ctx, channelId, actor.id);
      enforceChannelAdminRateLimit(ctx, channelId);
    }
    const member = requireActiveChannelMember(ctx, channelId, memberAgentDbId);
    if (member.permission === 'admin') {
      requireAnotherActiveChannelAdmin(ctx, channelId, member.agentDbId);
    }
    ctx.db.channelMember.id.update({
      ...member,
      permission: 'read',
      active: false,
      updatedAt: ctx.timestamp,
    });
  }
);
