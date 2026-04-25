import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_VISIBLE_DISCOVERABLE_CHANNELS,
  MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE,
  VisibleChannelRow,
  normalizeChannelSlug,
  normalizeOptionalChannelTitle,
  normalizeOptionalChannelDescription,
  enforceRateLimit,
  enforceChannelAdminRateLimit,
  normalizeChannelAccessMode,
  normalizePublicChannelJoinPermission,
  getReadableInbox,
  getOwnedActor,
  getOwnedActorForRead,
  requireAdminChannelMember,
  resolveRequiredChannel,
  ensureChannelMember,
  upsertPublicChannelRow,
  rebuildPublicRecentChannelMessages,
  buildChannelDiscoverableSortKey,
  buildChannelDiscoverableSortKeyFromCursor,
} = model;

function toVisibleChannelRow(channel: model.ChannelRow, exposeActivity: boolean) {
  return {
    id: channel.id,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    accessMode: channel.accessMode,
    publicJoinPermission: normalizePublicChannelJoinPermission(channel.publicJoinPermission),
    discoverable: channel.discoverable,
    creatorAgentDbId: exposeActivity ? channel.creatorAgentDbId : 0n,
    lastMessageSeq: exposeActivity ? channel.lastMessageSeq : 0n,
    createdAt: channel.createdAt,
    updatedAt: exposeActivity ? channel.updatedAt : channel.createdAt,
    lastMessageAt: exposeActivity ? channel.lastMessageAt : channel.createdAt,
  };
}

function getChannelSortKey(channel: model.ChannelRow) {
  return channel.discoverableSortKey === 'pending'
    ? buildChannelDiscoverableSortKey(channel)
    : channel.discoverableSortKey;
}

function compareDiscoverableChannels(left: model.ChannelRow, right: model.ChannelRow) {
  const leftSortKey = getChannelSortKey(left);
  const rightSortKey = getChannelSortKey(right);
  if (leftSortKey < rightSortKey) return -1;
  if (leftSortKey > rightSortKey) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

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
    for (const membership of ctx.db.channelMember.channel_member_inbox_id.filter(inbox.id)) {
      if (membership.active) {
        visibleChannelIds.add(membership.channelId);
        activeMemberChannelIds.add(membership.channelId);
      }
    }
    for (const request of ctx.db.channelJoinRequest.channel_join_request_requester_inbox_id.filter(inbox.id)) {
      if (request.status === 'pending') {
        visibleChannelIds.add(request.channelId);
      }
    }

    let discoverableCount = 0;
    const discoverableChannels = Array.from(ctx.db.channel.channel_discoverable.filter(true))
      .sort(compareDiscoverableChannels);
    for (const channel of discoverableChannels) {
      visibleChannelIds.add(channel.id);
      discoverableCount += 1;
      if (discoverableCount >= MAX_VISIBLE_DISCOVERABLE_CHANNELS) {
        break;
      }
    }

    return Array.from(visibleChannelIds)
      .map(channelId => ctx.db.channel.id.find(channelId))
      .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel))
      .map(channel =>
        toVisibleChannelRow(
          channel,
          channel.accessMode === 'public' || activeMemberChannelIds.has(channel.id)
        )
      );
  }
);

export const listDiscoverableChannels = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    beforeLastMessageAtMicros: t.u64().optional(),
    beforeChannelId: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(VisibleChannelRow),
  (ctx, { agentDbId, beforeLastMessageAtMicros, beforeChannelId, limit }) => {
    return ctx.withTx(tx => {
      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE)
          ? MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE
          : Number(limit);

      const actor = getOwnedActorForRead(tx, agentDbId);
      const activeMemberChannelIds = new Set<bigint>();
      for (const membership of tx.db.channelMember.channel_member_inbox_id.filter(actor.inboxId)) {
        if (membership.active) {
          activeMemberChannelIds.add(membership.channelId);
        }
      }

      const cursorSortKey =
        beforeLastMessageAtMicros === undefined
          ? undefined
          : buildChannelDiscoverableSortKeyFromCursor(
              beforeLastMessageAtMicros,
              beforeChannelId
            );
      const page: model.ChannelRow[] = [];
      const discoverableChannels = Array.from(tx.db.channel.channel_discoverable.filter(true))
        .filter(
          channel =>
            cursorSortKey === undefined || getChannelSortKey(channel) > cursorSortKey
        )
        .sort(compareDiscoverableChannels);
      for (const channel of discoverableChannels) {
        page.push(channel);
        if (page.length >= pageSize) break;
      }
      return page.map(channel =>
        toVisibleChannelRow(
          channel,
          channel.accessMode === 'public' || activeMemberChannelIds.has(channel.id)
        )
      );
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

    const inserted = ctx.db.channel.insert({
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
      discoverableSortKey: 'pending',
    });
    const channel = ctx.db.channel.id.update({
      ...inserted,
      discoverableSortKey: buildChannelDiscoverableSortKey(inserted),
    });
    ensureChannelMember(ctx, channel, actor, 'admin');
    upsertPublicChannelRow(ctx, channel);
  }
);

export const updateChannelSettings = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    accessMode: t.string().optional(),
    publicJoinPermission: t.string().optional(),
    discoverable: t.bool().optional(),
  },
  (ctx, { agentDbId, channelId, channelSlug, accessMode, publicJoinPermission, discoverable }) => {
    if (
      accessMode === undefined &&
      publicJoinPermission === undefined &&
      discoverable === undefined
    ) {
      throw new SenderError('At least one channel setting is required');
    }

    const actor = getOwnedActor(ctx, agentDbId);
    const channel = resolveRequiredChannel(ctx, { channelId, channelSlug });
    requireAdminChannelMember(ctx, channel.id, actor.id);
    enforceChannelAdminRateLimit(ctx, channel.id);

    const updatedChannel = ctx.db.channel.id.update({
      ...channel,
      accessMode:
        accessMode === undefined ? channel.accessMode : normalizeChannelAccessMode(accessMode),
      publicJoinPermission:
        publicJoinPermission === undefined
          ? channel.publicJoinPermission
          : normalizePublicChannelJoinPermission(publicJoinPermission),
      discoverable: discoverable ?? channel.discoverable,
      updatedAt: ctx.timestamp,
    });
    upsertPublicChannelRow(ctx, updatedChannel);
    const wasPublicDiscoverable = channel.accessMode === 'public' && channel.discoverable;
    const isPublicDiscoverable =
      updatedChannel.accessMode === 'public' && updatedChannel.discoverable;
    if (isPublicDiscoverable && !wasPublicDiscoverable) {
      rebuildPublicRecentChannelMessages(ctx, updatedChannel);
    }
  }
);

