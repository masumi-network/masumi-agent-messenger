import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleChannelRow,
  normalizeChannelSlug,
  normalizeOptionalChannelTitle,
  normalizeOptionalChannelDescription,
  enforceRateLimit,
  normalizeChannelAccessMode,
  normalizePublicChannelJoinPermission,
  getReadableInbox,
  getOwnedActor,
  ensureChannelMember,
  upsertPublicChannelRow,
} = model;
export const visibleChannels = spacetimedb.view(
  { public: true },
  t.array(VisibleChannelRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const visibleChannelIds = new Set<bigint>();
    const activeMemberChannelIds = new Set<bigint>();
    for (const channel of ctx.db.channel.channel_discoverable.filter(true)) {
      visibleChannelIds.add(channel.id);
    }
    for (const membership of ctx.db.channelMember.channel_member_inbox_id.filter(inbox.id)) {
      if (membership.active) {
        visibleChannelIds.add(membership.channelId);
        activeMemberChannelIds.add(membership.channelId);
      }
    }
    for (const request of ctx.db.channelJoinRequest.channel_join_request_requester_inbox_id.filter(inbox.id)) {
      visibleChannelIds.add(request.channelId);
    }

    return Array.from(visibleChannelIds)
      .map(channelId => ctx.db.channel.id.find(channelId))
      .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))
      .map(channel => {
        const exposeActivity =
          channel.accessMode === 'public' || activeMemberChannelIds.has(channel.id);
        return {
          id: channel.id,
          slug: channel.slug,
          title: channel.title,
          description: channel.description,
          accessMode: channel.accessMode,
          publicJoinPermission: normalizePublicChannelJoinPermission(
            channel.publicJoinPermission
          ),
          discoverable: channel.discoverable,
          creatorAgentDbId: exposeActivity ? channel.creatorAgentDbId : 0n,
          lastMessageSeq: exposeActivity ? channel.lastMessageSeq : 0n,
          createdAt: channel.createdAt,
          updatedAt: exposeActivity ? channel.updatedAt : channel.createdAt,
          lastMessageAt: exposeActivity ? channel.lastMessageAt : channel.createdAt,
        };
      });
  }
);

export const createChannel = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    slug: t.string(),
    title: t.string().optional(),
    description: t.string().optional(),
    accessMode: t.string(),
    publicJoinPermission: t.string().optional(),
    discoverable: t.bool(),
  },
  (
    ctx,
    {
      agentDbId,
      slug,
      title,
      description,
      accessMode,
      publicJoinPermission,
      discoverable,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const allowed = enforceRateLimit(ctx, {
      bucketKey: `channel_create:${ctx.sender.toHexString()}`,
      action: 'channel_create',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: model.CHANNEL_CREATE_RATE_WINDOW_MS,
      maxCount: model.CHANNEL_CREATE_RATE_MAX_PER_WINDOW,
    });
    if (!allowed) {
      throw new SenderError('Too many channels created; try again later');
    }
    const normalizedSlug = normalizeChannelSlug(slug);
    if (ctx.db.channel.slug.find(normalizedSlug)) {
      throw new SenderError('channelSlug is already registered');
    }
    const normalizedAccessMode = normalizeChannelAccessMode(accessMode);
    const normalizedPublicJoinPermission =
      normalizePublicChannelJoinPermission(publicJoinPermission);

    const channel = ctx.db.channel.insert({
      id: 0n,
      slug: normalizedSlug,
      title: normalizeOptionalChannelTitle(title),
      description: normalizeOptionalChannelDescription(description),
      accessMode: normalizedAccessMode,
      publicJoinPermission: normalizedPublicJoinPermission,
      discoverable,
      creatorAgentDbId: actor.id,
      nextChannelSeq: 1n,
      lastMessageSeq: 0n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      lastMessageAt: ctx.timestamp,
    });
    ensureChannelMember(ctx, channel, actor, 'admin');
    upsertPublicChannelRow(ctx, channel);
  }
);
