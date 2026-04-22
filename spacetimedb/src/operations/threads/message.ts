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
  SecretEnvelopeAttachment,
  VisibleMessageRow,
  requireNonEmpty,
  requireMaxLength,
  requireHexMaxLength,
  normalizeContactRequestStatus,
  requireMaxArrayLength,
  buildMessageThreadSeqKey,
  buildSenderSecretVisibilityKey,
  getOwnActorIdsForInbox,
  getRequiredInboxById,
  getRequiredActorByDbId,
  getRequiredActorByPublicIdentity,
  getReadableInbox,
  getOwnedActor,
  getContactRequestByThreadId,
  findPendingContactRequestForActors,
  isDirectContactAllowed,
  buildVisibleThreadIdsForInbox,
  getActiveThreadParticipants,
  createDirectThreadRecord,
  requireActiveThreadParticipant,
  getSenderLastSentState,
  senderHasMessageWithSecretVersion,
  canAgentReadMessage,
  requireExactEnvelopeCoverageForVersion,
  validateAttachedSecretEnvelopes,
  insertAttachedSecretEnvelopes,
} = model;
type ModuleCtx = model.ModuleCtx;
export const visibleMessages = spacetimedb.view(
  { public: true },
  t.array(VisibleMessageRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = getOwnActorIdsForInbox(ctx, inbox.id);
    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return Array.from(visibleThreadIds).flatMap(threadId => {
      const ownSenderVersionKeys = new Set(
        Array.from(ownActorIds).flatMap(agentDbId =>
          Array.from(
            ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(
              agentDbId
            )
          )
        )
          .filter(envelope => envelope.threadId === threadId)
          .map(envelope =>
            buildSenderSecretVisibilityKey(
              envelope.membershipVersion,
              envelope.senderAgentDbId,
              envelope.secretVersion
            )
          )
      );

      return Array.from(
        ctx.db.message.message_thread_id.filter(threadId)
      ).filter(
        message =>
          ownActorIds.has(message.senderAgentDbId) ||
          ownSenderVersionKeys.has(
            buildSenderSecretVisibilityKey(
              message.membershipVersion,
              message.senderAgentDbId,
              message.secretVersion
            )
          )
      );
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

  ctx.db.thread.id.update({
    ...thread,
    nextThreadSeq: threadSeq + 1n,
    lastMessageSeq: threadSeq,
    updatedAt: ctx.timestamp,
    lastMessageAt: ctx.timestamp,
  });

  ctx.db.threadParticipant.id.update({
    ...senderParticipant,
    lastSentSeq: params.senderSeq,
    lastSentMembershipVersion: thread.membershipVersion,
    lastSentSecretVersion: normalizedSecretVersion,
  });

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
