import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import {
  MAX_MESSAGE_ALGORITHM_CHARS,
  MAX_MESSAGE_CIPHERTEXT_HEX_CHARS,
  MAX_MESSAGE_IV_HEX_CHARS,
  MAX_MESSAGE_SIGNATURE_HEX_CHARS,
  MAX_MESSAGE_VERSION_CHARS,
} from '../../../../shared/message-limits';

import * as model from '../../model';

const {
  MAX_THREAD_FANOUT,
  MAX_THREAD_MESSAGE_PAGE_SIZE,
  CONTACT_REQUEST_RATE_WINDOW_MS,
  CONTACT_REQUEST_RATE_MAX_PER_WINDOW,
  SecretEnvelopeAttachment,
  VisibleThreadMessagePage,
  dedupeRowsById,
  enforceRateLimit,
  requireNonEmpty,
  requireMaxLength,
  requireHexMaxLength,
  normalizeContactRequestStatus,
  requireMaxArrayLength,
  buildMessageThreadSeqKey,
  buildThreadReadStateKey,
  getRequiredInboxById,
  getRequiredActorByDbId,
  getRequiredActorByPublicIdentity,
  getOwnedActor,
  getOwnedActorForRead,
  getContactRequestByThreadId,
  findPendingContactRequestForActors,
  isDirectContactAllowed,
  getThreadMessagesInSeqRange,
  getActiveThreadParticipants,
  createDirectThreadRecord,
  requireVisibleThreadParticipant,
  requireActiveThreadParticipant,
  getThreadReadStateForActor,
  getSenderLastSentState,
  senderHasMessageWithSecretVersion,
  canAgentReadMessage,
  requireExactEnvelopeCoverageForVersion,
  validateAttachedSecretEnvelopes,
  insertAttachedSecretEnvelopes,
  refreshInboxThreadProjectionsForThread,
} = model;
type ModuleCtx = model.ModuleCtx;

function toVisibleMessageRow(message: model.MessageRow) {
  return {
    id: message.id,
    threadId: message.threadId,
    threadSeq: message.threadSeq,
    membershipVersion: message.membershipVersion,
    senderAgentDbId: message.senderAgentDbId,
    senderSeq: message.senderSeq,
    secretVersion: message.secretVersion,
    secretVersionStart: message.secretVersionStart,
    signingKeyVersion: message.signingKeyVersion,
    ciphertext: message.ciphertext,
    iv: message.iv,
    cipherAlgorithm: message.cipherAlgorithm,
    signature: message.signature,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  };
}

function normalizeThreadMessagePageSize(limit: bigint) {
  if (limit === 0n) {
    throw new SenderError('limit is required and must be greater than zero');
  }
  return limit > BigInt(MAX_THREAD_MESSAGE_PAGE_SIZE)
    ? MAX_THREAD_MESSAGE_PAGE_SIZE
    : Number(limit);
}

function getThreadMessageUpperBound(
  thread: model.ThreadRow,
  beforeThreadSeq: bigint | undefined
) {
  const requestedUpperBound = beforeThreadSeq ?? thread.nextThreadSeq;
  return requestedUpperBound > thread.nextThreadSeq ? thread.nextThreadSeq : requestedUpperBound;
}

function readVisibleMessageRowsForThread(params: {
  ctx: model.ReadDbCtx;
  thread: model.ThreadRow;
  beforeThreadSeq?: bigint;
  limit: number;
  canReadMessage: (message: model.MessageRow) => boolean;
}) {
  const { ctx, thread, beforeThreadSeq, limit, canReadMessage } = params;
  const rows: model.MessageRow[] = [];
  let scanUpperBound = getThreadMessageUpperBound(thread, beforeThreadSeq);

  while (scanUpperBound > 1n && rows.length < limit) {
    const scanWindowSize = BigInt(limit);
    const lowerBound =
      scanUpperBound > scanWindowSize ? scanUpperBound - scanWindowSize : 1n;

    const candidates = getThreadMessagesInSeqRange(
      ctx,
      thread.id,
      lowerBound,
      scanUpperBound
    );

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const message = candidates[index];
      if (!message) {
        continue;
      }
      if (canReadMessage(message)) {
        rows.push(message);
        if (rows.length >= limit) {
          break;
        }
      }
    }

    scanUpperBound = lowerBound;
  }

  const oldestLoaded = rows[rows.length - 1];
  return {
    rows,
    nextBeforeThreadSeq:
      oldestLoaded && oldestLoaded.threadSeq > 1n ? oldestLoaded.threadSeq : undefined,
  };
}

function getMessageSecretVersionEnvelopes(ctx: model.ReadDbCtx, message: model.MessageRow) {
  return Array.from(
    ctx.db.threadSecretEnvelope.thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version.filter([
      message.threadId,
      message.membershipVersion,
      message.senderAgentDbId,
      message.secretVersion,
    ])
  );
}

function canActorReadMessageSecretVersion(
  ctx: model.ReadDbCtx,
  actorId: bigint,
  message: model.MessageRow
) {
  if (message.senderAgentDbId === actorId) {
    return true;
  }

  return getMessageSecretVersionEnvelopes(ctx, message).some(
    envelope => envelope.recipientAgentDbId === actorId
  );
}

function collectThreadPageSecretEnvelopes(params: {
  ctx: model.ReadDbCtx;
  viewerAgentDbId: bigint;
  messages: model.MessageRow[];
}) {
  const { ctx, viewerAgentDbId, messages } = params;
  if (messages.length === 0) {
    return [];
  }

  return dedupeRowsById(
    messages.flatMap(message =>
      getMessageSecretVersionEnvelopes(ctx, message).filter(envelope => {
        if (
          envelope.recipientAgentDbId !== viewerAgentDbId &&
          envelope.senderAgentDbId !== viewerAgentDbId
        ) {
          return false;
        }
        return true;
      })
    )
  );
}

export const listThreadMessages = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    beforeThreadSeq: t.u64().optional(),
    limit: t.u64(),
  },
  VisibleThreadMessagePage,
  (ctx, { agentDbId, threadId, beforeThreadSeq, limit }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const thread = tx.db.thread.id.find(threadId);
      if (!thread) {
        throw new SenderError('Thread not found');
      }
      requireVisibleThreadParticipant(tx, thread.id, actor.id);

      const pageSize = normalizeThreadMessagePageSize(limit);
      const page = readVisibleMessageRowsForThread({
        ctx: tx,
        thread,
        beforeThreadSeq,
        limit: pageSize,
        canReadMessage: message => canActorReadMessageSecretVersion(tx, actor.id, message),
      });

      return {
        messages: page.rows.map(toVisibleMessageRow),
        secretEnvelopes: collectThreadPageSecretEnvelopes({
          ctx: tx,
          viewerAgentDbId: actor.id,
          messages: page.rows,
        }),
        nextBeforeThreadSeq: page.nextBeforeThreadSeq,
      };
    });
  }
);

export const requestDirectContactWithFirstMessage = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    otherAgentPublicIdentity: t.string(),
    threadId: t.u64(),
    membershipLocked: t.bool().optional(),
    title: t.string().optional(),
    secretVersion: t.string(),
    signingKeyVersion: t.string(),
    senderSeq: t.u64(),
    ciphertext: t.string(),
    iv: t.string(),
    cipherAlgorithm: t.string(),
    signature: t.string(),
    replyToMessageId: t.u64().optional(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      otherAgentPublicIdentity,
      threadId,
      membershipLocked,
      title,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const otherActor = getRequiredActorByPublicIdentity(ctx, otherAgentPublicIdentity);

    if (actor.id === otherActor.id) {
      throw new SenderError('Direct threads require a second actor');
    }
    const contactAllowed = enforceRateLimit(ctx, {
      bucketKey: `contact_request:${ctx.sender.toHexString()}:${actor.id.toString()}`,
      action: 'contact_request',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: CONTACT_REQUEST_RATE_WINDOW_MS,
      maxCount: CONTACT_REQUEST_RATE_MAX_PER_WINDOW,
    });
    if (!contactAllowed) {
      throw new SenderError('Contact request rate limit exceeded; try again later');
    }
    if (isDirectContactAllowed(ctx, actor, otherActor)) {
      throw new SenderError('Direct contact is already allowed for this actor pair');
    }
    if (findPendingContactRequestForActors(ctx, actor, otherActor)) {
      throw new SenderError('A pending contact request already exists for this actor pair');
    }

    const requesterInbox = getRequiredInboxById(ctx, actor.inboxId);
    const thread = createDirectThreadRecord(ctx, actor, otherActor, {
      threadId,
      membershipLocked,
      title,
    });

    insertEncryptedMessageIntoThread(ctx, {
      senderActor: actor,
      threadId: thread.id,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
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
      hiddenMessageCount: 1n,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      resolvedAt: undefined,
      resolvedByAgentDbId: undefined,
    });
  }
);

function insertEncryptedMessageIntoThread(
  ctx: ModuleCtx,
  params: {
    senderActor: ReturnType<typeof getRequiredActorByDbId>;
    threadId: bigint;
    secretVersion: string;
    signingKeyVersion: string;
    senderSeq: bigint;
    ciphertext: string;
    iv: string;
    cipherAlgorithm: string;
    signature: string;
    replyToMessageId?: bigint;
    attachedSecretEnvelopes: Array<{
      recipientPublicIdentity: string;
      recipientEncryptionKeyVersion: string;
      senderEncryptionKeyVersion: string;
      signingKeyVersion: string;
      wrappedSecretCiphertext: string;
      wrappedSecretIv: string;
      wrapAlgorithm: string;
      signature: string;
    }>;
  }
) {
  const thread = ctx.db.thread.id.find(params.threadId);
  if (!thread) throw new SenderError('Thread not found');
  requireMaxArrayLength(
    params.attachedSecretEnvelopes,
    MAX_THREAD_FANOUT,
    'attachedSecretEnvelopes'
  );

  const normalizedSecretVersion = requireNonEmpty(params.secretVersion, 'secretVersion');
  const normalizedSigningVersion = requireNonEmpty(
    params.signingKeyVersion,
    'signingKeyVersion'
  );
  const normalizedCiphertext = requireHexMaxLength(
    params.ciphertext,
    MAX_MESSAGE_CIPHERTEXT_HEX_CHARS,
    'ciphertext'
  );
  const normalizedIv = requireHexMaxLength(params.iv, MAX_MESSAGE_IV_HEX_CHARS, 'iv');
  const normalizedAlgorithm = requireNonEmpty(params.cipherAlgorithm, 'cipherAlgorithm');
  const normalizedSignature = requireHexMaxLength(
    params.signature,
    MAX_MESSAGE_SIGNATURE_HEX_CHARS,
    'signature'
  );
  requireMaxLength(normalizedSecretVersion, MAX_MESSAGE_VERSION_CHARS, 'secretVersion');
  requireMaxLength(normalizedSigningVersion, MAX_MESSAGE_VERSION_CHARS, 'signingKeyVersion');
  requireMaxLength(normalizedAlgorithm, MAX_MESSAGE_ALGORITHM_CHARS, 'cipherAlgorithm');

  const activeParticipants = getActiveThreadParticipants(ctx, params.threadId);
  const senderParticipant = requireActiveThreadParticipant(ctx, params.threadId, params.senderActor.id);
  const contactRequest = getContactRequestByThreadId(ctx, params.threadId);
  const contactRequestAllowed = contactRequest
    ? isDirectContactAllowed(
        ctx,
        getRequiredActorByDbId(ctx, contactRequest.requesterAgentDbId),
        getRequiredActorByDbId(ctx, contactRequest.targetAgentDbId)
      )
    : false;

  if (contactRequest?.status.tag === 'pending' && !contactRequestAllowed) {
    if (contactRequest.requesterAgentDbId !== params.senderActor.id) {
      throw new SenderError('Only the requester may send before direct-contact approval');
    }

    if (contactRequest.hiddenMessageCount > 0n) {
      throw new SenderError(
        'Pending direct-contact threads allow only one hidden pre-approval message'
      );
    }
  } else if (contactRequest && contactRequest.status.tag !== 'approved' && !contactRequestAllowed) {
    throw new SenderError('Direct contact has not been approved for this thread');
  }

  if (normalizedSigningVersion !== params.senderActor.currentSigningKeyVersion) {
    throw new SenderError('signingKeyVersion must match the sender current signing key version');
  }

  const expectedSenderSeq = senderParticipant.lastSentSeq + 1n;
  if (params.senderSeq !== expectedSenderSeq) {
    throw new SenderError(`senderSeq must be ${expectedSenderSeq.toString()} for this sender`);
  }

  if (params.replyToMessageId !== undefined) {
    const replied = ctx.db.message.id.find(params.replyToMessageId);
    if (!replied || replied.threadId !== params.threadId) {
      throw new SenderError('replyToMessageId is invalid for this thread');
    }
    if (!canAgentReadMessage(ctx, params.senderActor.id, replied)) {
      throw new SenderError('replyToMessageId is not visible to the sender');
    }
  }

  const secretVersionStart = params.attachedSecretEnvelopes.length > 0;
  const latestSenderState = getSenderLastSentState(senderParticipant);

  if (!latestSenderState && !secretVersionStart) {
    throw new SenderError('The first message for a sender in this thread must publish a secretVersion');
  }
  if (
    latestSenderState &&
    latestSenderState.membershipVersion !== thread.membershipVersion &&
    !secretVersionStart
  ) {
    throw new SenderError(
      'Thread membership changed; the next message must start a new sender secretVersion'
    );
  }
  if (
    latestSenderState &&
    !secretVersionStart &&
    latestSenderState.secretVersion !== normalizedSecretVersion
  ) {
    throw new SenderError('Non-rotation messages must reuse the current sender secretVersion');
  }
  if (
    latestSenderState &&
    secretVersionStart &&
    latestSenderState.secretVersion === normalizedSecretVersion
  ) {
    throw new SenderError('Rotation messages must start a new secretVersion');
  }
  if (
    secretVersionStart &&
    senderHasMessageWithSecretVersion(
      ctx,
      params.threadId,
      params.senderActor.id,
      normalizedSecretVersion
    )
  ) {
    throw new SenderError('Rotation messages must use a never-before-used secretVersion');
  }

  if (secretVersionStart) {
    validateAttachedSecretEnvelopes({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants,
      attachedSecretEnvelopes: params.attachedSecretEnvelopes,
    });
    insertAttachedSecretEnvelopes({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      attachedSecretEnvelopes: params.attachedSecretEnvelopes,
    });
  } else {
    requireExactEnvelopeCoverageForVersion({
      ctx,
      threadId: params.threadId,
      membershipVersion: thread.membershipVersion,
      senderAgent: params.senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants,
    });
  }

  const threadSeq = thread.nextThreadSeq;
  if (threadSeq <= thread.lastMessageSeq && thread.lastMessageSeq !== 0n) {
    throw new SenderError('Thread sequence state is inconsistent');
  }
  ctx.db.message.insert({
    id: 0n,
    threadId: params.threadId,
    threadSeq,
    threadSeqKey: buildMessageThreadSeqKey(params.threadId, threadSeq),
    membershipVersion: thread.membershipVersion,
    senderAgentDbId: params.senderActor.id,
    senderSeq: params.senderSeq,
    secretVersion: normalizedSecretVersion,
    secretVersionStart,
    signingKeyVersion: normalizedSigningVersion,
    ciphertext: normalizedCiphertext,
    iv: normalizedIv,
    cipherAlgorithm: normalizedAlgorithm,
    signature: normalizedSignature,
    replyToMessageId: params.replyToMessageId,
    createdAt: ctx.timestamp,
  });

  const updatedThread = {
    ...thread,
    nextThreadSeq: threadSeq + 1n,
    lastMessageSeq: threadSeq,
    updatedAt: ctx.timestamp,
    lastMessageAt: ctx.timestamp,
  };
  ctx.db.thread.id.update(updatedThread);
  refreshInboxThreadProjectionsForThread(ctx, updatedThread);

  ctx.db.threadParticipant.id.update({
    ...senderParticipant,
    lastSentSeq: params.senderSeq,
    lastSentMembershipVersion: thread.membershipVersion,
    lastSentSecretVersion: normalizedSecretVersion,
  });

  // Sending from a thread counts as viewing it from that sender's inbox.
  // This keeps headless clients from showing their own outgoing message as unread.
  const existingReadState = getThreadReadStateForActor(ctx, params.threadId, params.senderActor.id);
  if (!existingReadState) {
    ctx.db.threadReadState.insert({
      id: 0n,
      threadId: params.threadId,
      agentDbId: params.senderActor.id,
      uniqueKey: buildThreadReadStateKey(params.threadId, params.senderActor.id),
      lastReadThreadSeq: threadSeq,
      archived: false,
      updatedAt: ctx.timestamp,
    });
  } else if (
    existingReadState.lastReadThreadSeq === undefined ||
    existingReadState.lastReadThreadSeq < threadSeq
  ) {
    ctx.db.threadReadState.id.update({
      ...existingReadState,
      lastReadThreadSeq: threadSeq,
      updatedAt: ctx.timestamp,
    });
  }

  if (contactRequest?.status.tag === 'pending' && !contactRequestAllowed) {
    ctx.db.contactRequest.id.update({
      ...contactRequest,
      hiddenMessageCount: contactRequest.hiddenMessageCount + 1n,
      updatedAt: ctx.timestamp,
    });
  }
}

export const sendEncryptedMessage = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    secretVersion: t.string(),
    signingKeyVersion: t.string(),
    senderSeq: t.u64(),
    ciphertext: t.string(),
    iv: t.string(),
    cipherAlgorithm: t.string(),
    signature: t.string(),
    replyToMessageId: t.u64().optional(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      threadId,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    }
  ) => {
    const senderActor = getOwnedActor(ctx, agentDbId);
    insertEncryptedMessageIntoThread(ctx, {
      senderActor,
      threadId,
      secretVersion,
      signingKeyVersion,
      senderSeq,
      ciphertext,
      iv,
      cipherAlgorithm,
      signature,
      replyToMessageId,
      attachedSecretEnvelopes,
    });
  }
);
