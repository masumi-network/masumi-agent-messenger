import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_VISIBLE_DISCOVERABLE_CHANNELS,
  MAX_DISCOVERABLE_CHANNEL_PAGE_SIZE,
  MAX_PUBLIC_CHANNEL_PAGE_SIZE,
  MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE,
  PublicChannelMirrorRow,
  PublicChannelPageRow,
  VisibleChannelState,
  VisibleChannelRow,
  normalizeChannelSlug,
  normalizeOptionalChannelTitle,
  normalizeOptionalChannelDescription,
  enforceRateLimit,
  enforceChannelAdminRateLimit,
  normalizeChannelAccessMode,
  normalizePublicChannelJoinPermission,
  buildPublicChannelSortKeyFromCursor,
  buildChannelJoinRequestKey,
  buildChannelMemberKey,
  dedupeRowsById,
  getReadableInbox,
  getOwnedActor,
  getOwnedActorForRead,
  getOwnActorIdsForInbox,
  getRequiredActorByDbId,
  toSanitizedVisibleAgentRow,
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

function toPublicChannelPageRow(channel: model.PublicChannelTableRow) {
  return {
    id: channel.id,
    channelId: channel.channelId,
    slug: channel.slug,
    title: channel.title,
    description: channel.description,
    accessMode: channel.accessMode,
    discoverable: channel.discoverable,
    lastMessageSeq: channel.lastMessageSeq,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    lastMessageAt: channel.lastMessageAt,
    publicJoinPermission: channel.publicJoinPermission,
  };
}

function toPublicChannelMirrorRow(channel: model.PublicChannelTableRow) {
  return {
    ...toPublicChannelPageRow(channel),
    sortKey: channel.sortKey,
  };
}

function toVisibleChannelMembershipRow(member: model.ChannelMemberRow) {
  return {
    id: member.id,
    channelId: member.channelId,
    agentDbId: member.agentDbId,
    permission: member.permission,
    active: member.active,
    lastSentSeq: member.lastSentSeq,
    joinedAt: member.joinedAt,
    updatedAt: member.updatedAt,
  };
}

function toVisibleChannelJoinRequestRow(
  ctx: model.ReadDbCtx,
  ownActorIds: ReadonlySet<bigint>,
  request: model.ChannelJoinRequestRow
) {
  const channel = ctx.db.channel.id.find(request.channelId);
  if (!channel) {
    throw new SenderError('Channel not found');
  }
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
}

function findChannelForRead(
  ctx: model.ReadDbCtx,
  params: {
    channelId?: bigint;
    channelSlug?: string;
  }
) {
  if (params.channelId !== undefined) {
    return ctx.db.channel.id.find(params.channelId) ?? null;
  }
  if (params.channelSlug !== undefined) {
    return ctx.db.channel.slug.find(normalizeChannelSlug(params.channelSlug)) ?? null;
  }
  return null;
}

function findPublicChannelForRead(
  ctx: model.ReadDbCtx,
  params: {
    channelId?: bigint;
    channelSlug?: string;
  }
) {
  if (params.channelId !== undefined) {
    return ctx.db.publicChannel.channelId.find(params.channelId) ?? null;
  }
  if (params.channelSlug !== undefined) {
    return ctx.db.publicChannel.slug.find(normalizeChannelSlug(params.channelSlug)) ?? null;
  }
  return null;
}

export const readPublicChannel = spacetimedb.procedure(
  {
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
  },
  t.array(PublicChannelMirrorRow),
  (ctx, { channelId, channelSlug }) => {
    return ctx.withTx(tx => {
      const channel = findPublicChannelForRead(tx, { channelId, channelSlug });
      return channel ? [toPublicChannelMirrorRow(channel)] : [];
    });
  }
);

export const listPublicChannels = spacetimedb.procedure(
  {
    beforeLastMessageAtMicros: t.u64().optional(),
    beforeChannelId: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(PublicChannelPageRow),
  (ctx, { beforeLastMessageAtMicros, beforeChannelId, limit }) => {
    return ctx.withTx(tx => {
      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_PUBLIC_CHANNEL_PAGE_SIZE)
          ? MAX_PUBLIC_CHANNEL_PAGE_SIZE
          : Number(limit);

      const cursorSortKey =
        beforeLastMessageAtMicros === undefined
          ? undefined
          : buildPublicChannelSortKeyFromCursor(
              beforeLastMessageAtMicros,
              beforeChannelId
            );
      const publicChannelPrefixRange = [true] as unknown as Parameters<
        typeof tx.db.publicChannel.public_channel_discoverable_sort_key.filter
      >[0];
      const publicChannelRows =
        tx.db.publicChannel.public_channel_discoverable_sort_key.filter(publicChannelPrefixRange);
      const page: model.PublicChannelTableRow[] = [];
      for (const channel of publicChannelRows) {
        if (cursorSortKey !== undefined && channel.sortKey <= cursorSortKey) {
          continue;
        }
        page.push(channel);
        if (page.length >= pageSize) break;
      }
      return page.map(toPublicChannelPageRow);
    });
  }
);

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
    const discoverablePrefixRange = [true] as unknown as Parameters<
      typeof ctx.db.channel.channel_discoverable_sort_key.filter
    >[0];
    for (const channel of ctx.db.channel.channel_discoverable_sort_key.filter(discoverablePrefixRange)) {
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

export const readVisibleChannelState = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    requestId: t.u64().optional(),
  },
  VisibleChannelState,
  (ctx, { agentDbId, channelId, channelSlug, requestId }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const ownActorIds = getOwnActorIdsForInbox(tx, actor.inboxId);
      const requestById =
        requestId === undefined ? null : tx.db.channelJoinRequest.id.find(requestId) ?? null;
      const channel =
        findChannelForRead(tx, { channelId, channelSlug }) ??
        (requestById ? tx.db.channel.id.find(requestById.channelId) ?? null : null);
      const emptyState = {
        actors: [toSanitizedVisibleAgentRow(tx, actor.inboxId, actor)],
        channels: [],
        memberships: [],
        requests: [],
      };
      if (!channel) {
        return emptyState;
      }

      const memberships = Array.from(ownActorIds)
        .map(ownActorId =>
          tx.db.channelMember.uniqueKey.find(buildChannelMemberKey(channel.id, ownActorId))
        )
        .filter((member): member is NonNullable<typeof member> => Boolean(member));
      const activeMemberships = memberships.filter(member => member.active);
      const hasActiveMembership = activeMemberships.length > 0;
      const hasAdminMembership = activeMemberships.some(member => member.permission === 'admin');
      const ownRequests = Array.from(ownActorIds)
        .map(ownActorId =>
          tx.db.channelJoinRequest.uniqueKey.find(
            buildChannelJoinRequestKey(channel.id, ownActorId)
          )
        )
        .filter((request): request is NonNullable<typeof request> => Boolean(request));
      const hasPendingOwnRequest = ownRequests.some(request => request.status === 'pending');
      if (
        requestById !== null &&
        !ownActorIds.has(requestById.requesterAgentDbId) &&
        !hasAdminMembership
      ) {
        return emptyState;
      }
      const channelIsVisible =
        channel.accessMode === 'public' ||
        channel.discoverable ||
        hasActiveMembership ||
        hasPendingOwnRequest;
      if (!channelIsVisible) {
        return emptyState;
      }

      const adminRequests: model.ChannelJoinRequestRow[] = [];
      if (hasAdminMembership) {
        for (const request of tx.db.channelJoinRequest.channel_join_request_channel_id.filter(
          channel.id
        )) {
          adminRequests.push(request);
          if (adminRequests.length >= MAX_CHANNEL_JOIN_REQUEST_PAGE_SIZE) {
            break;
          }
        }
      }
      const channelRequests =
        requestById !== null
          ? [requestById]
          : dedupeRowsById([...ownRequests, ...adminRequests]);
      const visibleRequests = channelRequests.filter(
        request =>
          request.channelId === channel.id &&
          (ownActorIds.has(request.requesterAgentDbId) || hasAdminMembership)
      );
      const visibleActorIds = new Set<bigint>([actor.id]);
      for (const member of memberships) {
        visibleActorIds.add(member.agentDbId);
      }
      for (const request of visibleRequests) {
        if (ownActorIds.has(request.requesterAgentDbId)) {
          visibleActorIds.add(request.requesterAgentDbId);
        }
      }

      return {
        actors: Array.from(visibleActorIds)
          .map(visibleActorId => tx.db.agent.id.find(visibleActorId))
          .filter((visibleActor): visibleActor is NonNullable<typeof visibleActor> =>
            Boolean(visibleActor)
          )
          .map(visibleActor => toSanitizedVisibleAgentRow(tx, actor.inboxId, visibleActor)),
        channels: [
          toVisibleChannelRow(
            channel,
            channel.accessMode === 'public' || hasActiveMembership
          ),
        ],
        memberships: memberships.map(toVisibleChannelMembershipRow),
        requests: visibleRequests.map(request =>
          toVisibleChannelJoinRequestRow(tx, ownActorIds, request)
        ),
      };
    });
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
      const discoverablePrefixRange = [true] as unknown as Parameters<
        typeof tx.db.channel.channel_discoverable_sort_key.filter
      >[0];
      const discoverableChannels =
        tx.db.channel.channel_discoverable_sort_key.filter(discoverablePrefixRange);
      const page: model.ChannelRow[] = [];
      for (const channel of discoverableChannels) {
        if (cursorSortKey !== undefined && channel.discoverableSortKey <= cursorSortKey) {
          continue;
        }
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
