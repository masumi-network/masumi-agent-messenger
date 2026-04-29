import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import {
  MAX_MESSAGE_SIGNATURE_HEX_CHARS,
  MAX_MESSAGE_VERSION_CHARS,
} from '../../../../shared/message-limits';

import * as model from '../../model';

const {
  MAX_CHANNEL_MESSAGE_PAGE_SIZE,
  MAX_CHANNEL_RECENT_PUBLIC_MESSAGES,
  MAX_PUBLIC_RECENT_CHANNEL_MESSAGE_VIEW_ROWS,
  ChannelMessageRow,
  PublicRecentChannelMessageRow,
  requireNonEmpty,
  requireMaxLength,
  requireHexMaxLength,
  normalizeChannelPlaintext,
  enforceRateLimit,
  buildChannelMessageSeqKey,
  getRequiredChannelById,
  resolveRequiredChannel,
  getOwnedActor,
  getOwnedActorForRead,
  requireChannelSendPermission,
  requireChannelReadableByActor,
  upsertPublicChannelRow,
  toChannelMessageRow,
  insertPublicRecentChannelMessage,
  getChannelMessagesInSeqRange,
  buildChannelDiscoverableSortKey,
} = model;

function toPublicRecentChannelMessageRow(message: model.PublicRecentChannelMessageRecordRow) {
  return {
    id: message.id,
    channelId: message.channelId,
    channelSeq: message.channelSeq,
    channelSeqKey: message.channelSeqKey,
    senderAgentDbId: message.senderAgentDbId,
    senderPublicIdentity: message.senderPublicIdentity,
    senderSeq: message.senderSeq,
    senderSigningKeyVersion: message.senderSigningKeyVersion,
    plaintext: message.plaintext,
    signature: message.signature,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
    senderSigningPublicKey: message.senderSigningPublicKey,
  };
}

export const publicRecentChannelMessages = spacetimedb.anonymousView(
  { public: true },
  t.array(PublicRecentChannelMessageRow),
  ctx => {
    const visiblePrefixRange = [true] as unknown as Parameters<
      typeof ctx.db.publicRecentChannelMessage.public_recent_channel_message_visible_sort_key.filter
    >[0];
    const rows: model.PublicRecentChannelMessageRecordRow[] = [];
    for (const message of ctx.db.publicRecentChannelMessage.public_recent_channel_message_visible_sort_key.filter(
      visiblePrefixRange
    )) {
      if (!ctx.db.publicChannel.channelId.find(message.channelId)) {
        continue;
      }
      rows.push(message);
      if (rows.length >= MAX_PUBLIC_RECENT_CHANNEL_MESSAGE_VIEW_ROWS) {
        break;
      }
    }
    return rows.map(toPublicRecentChannelMessageRow);
  }
);

function resolvePublicChannelForRead(
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
    const channel = ctx.db.channel.slug.find(model.normalizeChannelSlug(params.channelSlug));
    if (!channel) {
      return null;
    }
    return ctx.db.publicChannel.channelId.find(channel.id) ?? null;
  }
  return null;
}

export const listPublicChannelMessages = spacetimedb.procedure(
  {
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    beforeChannelSeq: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(PublicRecentChannelMessageRow),
  (ctx, { channelId, channelSlug, beforeChannelSeq, limit }) => {
    return ctx.withTx(tx => {
      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_CHANNEL_RECENT_PUBLIC_MESSAGES)
          ? MAX_CHANNEL_RECENT_PUBLIC_MESSAGES
          : Number(limit);
      const channel = resolvePublicChannelForRead(tx, { channelId, channelSlug });
      if (!channel) {
        return [];
      }

      const channelSeqPrefixRange = [channel.channelId] as unknown as Parameters<
        typeof tx.db.publicRecentChannelMessage.public_recent_channel_message_channel_id_seq.filter
      >[0];
      const rows = Array.from(
        tx.db.publicRecentChannelMessage.public_recent_channel_message_channel_id_seq.filter(
          channelSeqPrefixRange
        )
      )
        .filter(message =>
          beforeChannelSeq === undefined ? true : message.channelSeq < beforeChannelSeq
        )
        .sort((left, right) => {
          if (left.channelSeq < right.channelSeq) return 1;
          if (left.channelSeq > right.channelSeq) return -1;
          if (left.id < right.id) return 1;
          if (left.id > right.id) return -1;
          return 0;
        })
        .slice(0, pageSize);
      return rows.reverse().map(toPublicRecentChannelMessageRow);
    });
  }
);

export const listChannelMessages = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    beforeChannelSeq: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(ChannelMessageRow),
  (ctx, { agentDbId, channelId, channelSlug, beforeChannelSeq, limit }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const channel = resolveRequiredChannel(tx, { channelId, channelSlug });
      requireChannelReadableByActor(tx, channel, actor);

      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_CHANNEL_MESSAGE_PAGE_SIZE)
          ? MAX_CHANNEL_MESSAGE_PAGE_SIZE
          : Number(limit);
      const requestedUpperBound = beforeChannelSeq ?? channel.nextChannelSeq;
      const upperBound =
        requestedUpperBound > channel.nextChannelSeq ? channel.nextChannelSeq : requestedUpperBound;
      if (upperBound <= 1n) {
        return [];
      }
      const lowerBound =
        upperBound > BigInt(pageSize) ? upperBound - BigInt(pageSize) : 1n;

      const messages = getChannelMessagesInSeqRange(tx, channel.id, lowerBound, upperBound);
      const rows: model.ChannelMessageRecordRow[] = [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message) {
          rows.push(message);
        }
      }
      return rows.map(message => toChannelMessageRow(tx, message));
    });
  }
);

export const sendChannelMessage = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    channelId: t.u64(),
    senderSeq: t.u64(),
    senderSigningKeyVersion: t.string(),
    plaintext: t.string(),
    signature: t.string(),
    replyToMessageId: t.u64().optional(),
  },
  (
    ctx,
    {
      agentDbId,
      channelId,
      senderSeq,
      senderSigningKeyVersion,
      plaintext,
      signature,
      replyToMessageId,
    }
  ) => {
    const senderAgent = getOwnedActor(ctx, agentDbId);
    const channel = getRequiredChannelById(ctx, channelId);
    const senderMember = requireChannelSendPermission(ctx, channel.id, senderAgent.id);
    const allowed = enforceRateLimit(ctx, {
      bucketKey: `channel_message:${ctx.sender.toHexString()}:${channel.id.toString()}`,
      action: 'channel_message',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: model.CHANNEL_MESSAGE_RATE_WINDOW_MS,
      maxCount: model.CHANNEL_MESSAGE_RATE_MAX_PER_WINDOW,
    });
    if (!allowed) {
      throw new SenderError('Channel message rate limit exceeded; slow down');
    }
    const normalizedSigningKeyVersion = requireNonEmpty(
      senderSigningKeyVersion,
      'senderSigningKeyVersion'
    );
    requireMaxLength(
      normalizedSigningKeyVersion,
      MAX_MESSAGE_VERSION_CHARS,
      'senderSigningKeyVersion'
    );
    if (normalizedSigningKeyVersion !== senderAgent.currentSigningKeyVersion) {
      throw new SenderError('senderSigningKeyVersion must match the sender current signing key');
    }
    const normalizedPlaintext = normalizeChannelPlaintext(plaintext);
    const normalizedSignature = requireHexMaxLength(
      signature,
      MAX_MESSAGE_SIGNATURE_HEX_CHARS,
      'signature'
    );
    const expectedSenderSeq = senderMember.lastSentSeq + 1n;
    if (senderSeq !== expectedSenderSeq) {
      throw new SenderError(`senderSeq must be ${expectedSenderSeq.toString()} for this sender`);
    }
    if (replyToMessageId !== undefined) {
      const replied = ctx.db.channelMessage.id.find(replyToMessageId);
      if (!replied || replied.channelId !== channel.id) {
        throw new SenderError('replyToMessageId is invalid for this channel');
      }
    }

    const channelSeq = channel.lastMessageSeq + 1n;

    const message = ctx.db.channelMessage.insert({
      id: 0n,
      channelId: channel.id,
      channelSeq,
      channelSeqKey: buildChannelMessageSeqKey(channel.id, channelSeq),
      senderAgentDbId: senderAgent.id,
      senderPublicIdentity: senderAgent.publicIdentity,
      senderSeq,
      senderSigningPublicKey: senderAgent.currentSigningPublicKey,
      senderSigningKeyVersion: normalizedSigningKeyVersion,
      plaintext: normalizedPlaintext,
      signature: normalizedSignature,
      replyToMessageId,
      createdAt: ctx.timestamp,
    });

    const updatedChannel = ctx.db.channel.id.update({
      ...channel,
      nextChannelSeq: channelSeq + 1n,
      lastMessageSeq: channelSeq,
      updatedAt: ctx.timestamp,
      lastMessageAt: ctx.timestamp,
      discoverableSortKey: buildChannelDiscoverableSortKey({
        id: channel.id,
        lastMessageAt: ctx.timestamp,
      }),
    });
    ctx.db.channelMember.id.update({
      ...senderMember,
      lastSentSeq: senderSeq,
      updatedAt: ctx.timestamp,
    });
    if (updatedChannel.accessMode === 'public') {
      upsertPublicChannelRow(ctx, updatedChannel);
      insertPublicRecentChannelMessage(ctx, message);
    }
  }
);
