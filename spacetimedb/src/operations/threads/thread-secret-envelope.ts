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
  getOwnedActor,
  requirePendingDirectContactResolvedForThreadMutation,
  buildVisibleThreadIdsForInbox,
  getActiveThreadParticipants,
  requireActiveThreadParticipant,
  senderHasMessageForMembershipSecretVersion,
  validateBackfillSecretEnvelopes,
  insertAttachedSecretEnvelopes,
} = model;
export const visibleThreadSecretEnvelopes = spacetimedb.view(
  { public: true },
  t.array(VisibleThreadSecretEnvelopeRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    const ownActorIds = new Set(
      Array.from(ctx.db.agent.agent_inbox_id.filter(inbox.id)).map(actor => actor.id)
    );
    const visibleThreadIds = buildVisibleThreadIdsForInbox(ctx, inbox.id);

    return dedupeRowsById(
      Array.from(ownActorIds).flatMap(agentDbId => [
        ...Array.from(
          ctx.db.threadSecretEnvelope.thread_secret_envelope_sender_agent_db_id.filter(agentDbId)
        ),
        ...Array.from(
          ctx.db.threadSecretEnvelope.thread_secret_envelope_recipient_agent_db_id.filter(agentDbId)
        ),
      ]).filter(envelope => visibleThreadIds.has(envelope.threadId))
    );
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
