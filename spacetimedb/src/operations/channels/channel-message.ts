import { Range, t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import {
  MAX_MESSAGE_SIGNATURE_HEX_CHARS,
  MAX_MESSAGE_VERSION_CHARS,
} from '../../../../shared/message-limits';

import * as model from '../../model';

const {
  MAX_CHANNEL_RECENT_PUBLIC_MESSAGES,
  MAX_CHANNEL_MESSAGE_PAGE_SIZE,
  ChannelMessageRow,
  VisibleChannelMessageRow,
  requireNonEmpty,
  requireMaxLength,
  requireHexMaxLength,
  normalizeChannelPlaintext,
  enforceRateLimit,
  buildChannelMessageSeqKey,
  getRequiredChannelById,
  resolveRequiredChannel,
  getReadableInbox,
  getOwnedActor,
  getOwnedActorForRead,
  requireChannelSendPermission,
  requireChannelReadableByActor,
  isChannelMemberReadable,
  upsertPublicChannelRow,
  toChannelMessageRow,
  insertPublicRecentChannelMessage,
} = model;
export const visibleChannelMessages = spacetimedb.view(
  { public: true },
  t.array(VisibleChannelMessageRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const readableChannelIds = new Set(
      Array.from(ctx.db.channelMember.channel_member_inbox_id.filter(inbox.id))
        .filter(isChannelMemberReadable)
        .map(member => member.channelId)
    );

    return Array.from(readableChannelIds)
      .flatMap(channelId => {
        const channel = ctx.db.channel.id.find(channelId);
        if (!channel) {
          return [];
        }

        const upperBound = channel.nextChannelSeq;
        if (upperBound <= 1n) {
          return [];
        }
        const lowerBound =
          upperBound > BigInt(MAX_CHANNEL_RECENT_PUBLIC_MESSAGES)
            ? upperBound - BigInt(MAX_CHANNEL_RECENT_PUBLIC_MESSAGES)
            : 1n;

        return Array.from(
          ctx.db.channelMessage.channel_message_channel_id_channel_seq.filter([
            channel.id,
            new Range(
              { tag: 'included', value: lowerBound },
              { tag: 'excluded', value: upperBound }
            ),
          ])
        )
          .sort((left, right) => {
            if (left.channelSeq > right.channelSeq) return -1;
            if (left.channelSeq < right.channelSeq) return 1;
            return Number(right.id - left.id);
          })
          .map(message => toChannelMessageRow(ctx, message));
      })
      .sort((left, right) => {
        if (left.channelId < right.channelId) return -1;
        if (left.channelId > right.channelId) return 1;
        if (left.channelSeq < right.channelSeq) return -1;
        if (left.channelSeq > right.channelSeq) return 1;
        return Number(left.id - right.id);
      });
  }
);

export const listChannelMessages = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    channelId: t.u64().optional(),
    channelSlug: t.string().optional(),
    beforeChannelSeq: t.u64().optional(),
    limit: t.u64().optional(),
  },
  t.array(ChannelMessageRow),
  (ctx, { agentDbId, channelId, channelSlug, beforeChannelSeq, limit }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const channel = resolveRequiredChannel(tx, { channelId, channelSlug });
      requireChannelReadableByActor(tx, channel, actor);

      const pageSize =
        limit === undefined || limit === 0n || limit > BigInt(MAX_CHANNEL_MESSAGE_PAGE_SIZE)
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

      return Array.from(
        tx.db.channelMessage.channel_message_channel_id_channel_seq.filter([
          channel.id,
          new Range(
            { tag: 'included', value: lowerBound },
            { tag: 'excluded', value: upperBound }
          ),
        ])
      )
        .sort((left, right) => {
          if (left.channelSeq > right.channelSeq) return -1;
          if (left.channelSeq < right.channelSeq) return 1;
          return Number(right.id - left.id);
        })
        .map(message => toChannelMessageRow(tx, message));
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

    const channelSeq = channel.nextChannelSeq;
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
