import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import { MAX_MESSAGE_VERSION_CHARS } from '../../../../shared/message-limits';

import * as model from '../../model';

const {
  SecretEnvelopeAttachment,
  VisibleThreadSecretEnvelopeRow,
  requireNonEmpty,
  requireMaxLength,
  dedupeRowsById,
  getReadableInbox,
  getOwnActorIdsForInbox,
  getOwnedActor,
  getOwnedActorForRead,
  requirePendingDirectContactResolvedForThreadMutation,
  getLatestVisibleThreadsForInbox,
  getLatestThreadMessages,
  buildSenderSecretVisibilityKey,
  canAnyAgentReadMessage,
  getActiveThreadParticipants,
  requireActiveThreadParticipant,
  requireVisibleThreadParticipant,
  senderHasMessageForMembershipSecretVersion,
  validateBackfillSecretEnvelopes,
  insertAttachedSecretEnvelopes,
} = model;

function toVisibleThreadSecretEnvelopeRow(
  envelope: model.ThreadSecretEnvelopeRow
) {
  return {
    id: envelope.id,
    threadId: envelope.threadId,
    membershipVersion: envelope.membershipVersion,
    secretVersion: envelope.secretVersion,
    senderAgentDbId: envelope.senderAgentDbId,
    recipientAgentDbId: envelope.recipientAgentDbId,
    senderEncryptionKeyVersion: envelope.senderEncryptionKeyVersion,
    recipientEncryptionKeyVersion: envelope.recipientEncryptionKeyVersion,
    signingKeyVersion: envelope.signingKeyVersion,
    wrappedSecretCiphertext: envelope.wrappedSecretCiphertext,
    wrappedSecretIv: envelope.wrappedSecretIv,
    wrapAlgorithm: envelope.wrapAlgorithm,
    signature: envelope.signature,
    createdAt: envelope.createdAt,
  };
}

function listReadableThreadSecretEnvelopes(
  ctx: model.ReadDbCtx,
  ownActorIds: ReadonlySet<bigint>,
  keys: Array<{
    threadId: bigint;
    membershipVersion: bigint;
    senderAgentDbId: bigint;
    secretVersion: string;
  }>
) {
  return dedupeRowsById(
    keys.flatMap(key =>
      Array.from(
        ctx.db.threadSecretEnvelope.thread_secret_envelope_thread_id_membership_version_sender_agent_db_id_secret_version.filter([
          key.threadId,
          key.membershipVersion,
          key.senderAgentDbId,
          key.secretVersion,
        ])
      ).filter(
        envelope =>
          ownActorIds.has(envelope.senderAgentDbId) ||
          ownActorIds.has(envelope.recipientAgentDbId)
      )
    )
  ).map(toVisibleThreadSecretEnvelopeRow);
}

function buildMessageSecretKeys(messages: model.MessageRow[]) {
  const seen = new Set<string>();
  const keys: Array<{
    threadId: bigint;
    membershipVersion: bigint;
    senderAgentDbId: bigint;
    secretVersion: string;
  }> = [];

  for (const message of messages) {
    const key = `${message.threadId.toString()}:${buildSenderSecretVisibilityKey(
      message.membershipVersion,
      message.senderAgentDbId,
      message.secretVersion
    )}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push({
      threadId: message.threadId,
      membershipVersion: message.membershipVersion,
      senderAgentDbId: message.senderAgentDbId,
      secretVersion: message.secretVersion,
    });
  }

  return keys;
}

export const visibleThreadSecretEnvelopes = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadSecretEnvelopeRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = getOwnActorIdsForInbox(ctx, inbox.id);
    const keys = getLatestVisibleThreadsForInbox(ctx, inbox.id).flatMap(thread =>
      buildMessageSecretKeys(
        getLatestThreadMessages(ctx, thread).filter(message =>
          canAnyAgentReadMessage(ctx, ownActorIds, message)
        )
      )
    );

    return listReadableThreadSecretEnvelopes(ctx, ownActorIds, keys);
  }
);

export const listThreadSecretEnvelopes = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    membershipVersion: t.u64().optional(),
    senderAgentDbId: t.u64().optional(),
    secretVersion: t.string().optional(),
  },
  t.array(VisibleThreadSecretEnvelopeRow),
  (ctx, { agentDbId, threadId, membershipVersion, senderAgentDbId, secretVersion }) => {
    return ctx.withTx(tx => {
      const actor = getOwnedActorForRead(tx, agentDbId);
      const thread = tx.db.thread.id.find(threadId);
      if (!thread) {
        throw new SenderError('Thread not found');
      }
      requireVisibleThreadParticipant(tx, thread.id, actor.id);

      const ownActorIds = getOwnActorIdsForInbox(tx, actor.inboxId);
      const hasExactKey =
        membershipVersion !== undefined &&
        senderAgentDbId !== undefined &&
        secretVersion !== undefined;
      const keys = hasExactKey
        ? [
            {
              threadId: thread.id,
              membershipVersion,
              senderAgentDbId,
              secretVersion,
            },
          ]
        : buildMessageSecretKeys(
            getLatestThreadMessages(tx, thread).filter(message =>
              canAnyAgentReadMessage(tx, ownActorIds, message)
            )
          );

      return listReadableThreadSecretEnvelopes(tx, ownActorIds, keys);
    });
  }
);

export const backfillThreadSecretEnvelopes = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    threadId: t.u64(),
    membershipVersion: t.u64(),
    secretVersion: t.string(),
    attachedSecretEnvelopes: t.array(SecretEnvelopeAttachment),
  },
  (
    ctx,
    {
      agentDbId,
      threadId,
      membershipVersion,
      secretVersion,
      attachedSecretEnvelopes,
    }
  ) => {
    const senderActor = getOwnedActor(ctx, agentDbId);
    const thread = ctx.db.thread.id.find(threadId);
    if (!thread) throw new SenderError('Thread not found');
    if (membershipVersion === 0n || membershipVersion >= thread.membershipVersion) {
      throw new SenderError('Backfill membershipVersion must reference a prior thread membership');
    }

    requireActiveThreadParticipant(ctx, threadId, senderActor.id);
    requirePendingDirectContactResolvedForThreadMutation(ctx, threadId);

    const normalizedSecretVersion = requireNonEmpty(secretVersion, 'secretVersion');
    requireMaxLength(normalizedSecretVersion, MAX_MESSAGE_VERSION_CHARS, 'secretVersion');
    if (
      !senderHasMessageForMembershipSecretVersion(
        ctx,
        threadId,
        membershipVersion,
        senderActor.id,
        normalizedSecretVersion
      )
    ) {
      throw new SenderError('No historical message exists for this sender secretVersion');
    }

    validateBackfillSecretEnvelopes({
      ctx,
      threadId,
      membershipVersion,
      senderAgent: senderActor,
      secretVersion: normalizedSecretVersion,
      activeParticipants: getActiveThreadParticipants(ctx, threadId),
      attachedSecretEnvelopes,
    });

    insertAttachedSecretEnvelopes({
      ctx,
      threadId,
      membershipVersion,
      senderAgent: senderActor,
      secretVersion: normalizedSecretVersion,
      attachedSecretEnvelopes,
    });
  }
);
