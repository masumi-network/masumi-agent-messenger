import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import { MAX_MESSAGE_VERSION_CHARS } from '../../../../shared/message-limits';

import * as model from '../../model';

const {
  MAX_THREAD_FANOUT,
  MAX_CHANNEL_MESSAGE_PAGE_SIZE,
  MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS,
  MAX_AGENT_KEY_BUNDLE_PAGE_SIZE,
  DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
  DEFAULT_AGENT_SIGNING_ALGORITHM,
  AGENT_KEY_ROTATE_RATE_WINDOW_MS,
  AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW,
  DeviceKeyBundleAttachment,
  AgentPublicKeyLookupRequest,
  AgentPublicKeyLookupRow,
  PublishedAgentSigningKeyLookupRequest,
  PublishedAgentSigningKeyLookupRow,
  VisibleAgentKeyBundleRow,
  enforceRateLimit,
  requireNonEmpty,
  requireMaxLength,
  normalizePublicKey,
  normalizeDeviceId,
  normalizeDeviceStatus,
  normalizeOptionalAlgorithm,
  requireMaxArrayLength,
  refreshInboxAuthLeaseForInbox,
  buildAgentKeyBundleKey,
  buildAgentKeyBundleSortKey,
  repairPendingAgentKeyBundleSortKeys,
  getOwnedActorWithInbox,
  getOwnedActorForRead,
  buildVisibleAgentIdsForInbox,
  getOwnedDevice,
  invalidatePendingDeviceShareRequests,
  invalidatePendingDeviceKeyBundles,
  insertDeviceKeyBundle,
} = model;

type AgentPublicKeyKind = 'encryption' | 'signing';

function normalizeAgentPublicKeyKind(value: string): AgentPublicKeyKind {
  const normalized = requireNonEmpty(value, 'keyKind');
  if (normalized !== 'encryption' && normalized !== 'signing') {
    throw new SenderError('keyKind must be encryption or signing');
  }
  return normalized;
}

function findAgentPublicKeyBundle(
  ctx: model.ReadDbCtx,
  agentDbId: bigint,
  kind: AgentPublicKeyKind,
  keyVersion: string
) {
  if (kind === 'encryption') {
    return (
      Array.from(
        ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id_encryption_key_version.filter([
          agentDbId,
          keyVersion,
        ])
      )[0] ?? null
    );
  }

  return (
    Array.from(
      ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id_signing_key_version.filter([
        agentDbId,
        keyVersion,
      ])
    )[0] ?? null
  );
}

function toAgentPublicKeyLookupRow(
  bundle: model.AgentKeyBundleRow,
  kind: AgentPublicKeyKind,
  keyVersion: string
) {
  return {
    agentDbId: bundle.agentDbId,
    publicIdentity: bundle.publicIdentity,
    keyKind: kind,
    keyVersion,
    publicKey:
      kind === 'encryption' ? bundle.encryptionPublicKey : bundle.signingPublicKey,
    algorithm:
      kind === 'encryption' ? bundle.encryptionAlgorithm : bundle.signingAlgorithm,
    keyBundleId: bundle.id,
    createdAt: bundle.createdAt,
  };
}

export const lookupAgentPublicKeys = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    requests: t.array(AgentPublicKeyLookupRequest),
  },
  t.array(AgentPublicKeyLookupRow),
  (ctx, { agentDbId, requests }) => {
    return ctx.withTx(tx => {
      requireMaxArrayLength(
        requests,
        MAX_AGENT_PUBLIC_KEY_LOOKUP_REQUESTS,
        'requests'
      );

      const actor = getOwnedActorForRead(tx, agentDbId);
      const visibleAgentIds = buildVisibleAgentIdsForInbox(tx, actor.inboxId);
      const seen = new Set<string>();
      const resolved: Array<ReturnType<typeof toAgentPublicKeyLookupRow>> = [];

      for (const request of requests) {
        if (!visibleAgentIds.has(request.agentDbId)) {
          throw new SenderError('Requested agent is not visible to this actor');
        }

        const keyKind = normalizeAgentPublicKeyKind(request.keyKind);
        const keyVersion = requireNonEmpty(request.keyVersion, 'keyVersion');
        requireMaxLength(keyVersion, MAX_MESSAGE_VERSION_CHARS, 'keyVersion');

        const requestKey = `${request.agentDbId.toString()}:${keyKind}:${keyVersion}`;
        if (seen.has(requestKey)) {
          continue;
        }
        seen.add(requestKey);

        const bundle = findAgentPublicKeyBundle(
          tx,
          request.agentDbId,
          keyKind,
          keyVersion
        );
        if (!bundle) {
          continue;
        }

        resolved.push(toAgentPublicKeyLookupRow(bundle, keyKind, keyVersion));
      }

      return resolved;
    });
  }
);

export const lookupAgentKeyBundles = spacetimedb.procedure(
  {
    agentDbId: t.u64(),
    peerAgentDbId: t.u64(),
    beforeBundleId: t.u64().optional(),
    limit: t.u64(),
  },
  t.array(VisibleAgentKeyBundleRow),
  (ctx, { agentDbId, peerAgentDbId, beforeBundleId, limit }) => {
    return ctx.withTx(tx => {
      if (limit === 0n) {
        throw new SenderError('limit is required and must be greater than zero');
      }
      const pageSize =
        limit > BigInt(MAX_AGENT_KEY_BUNDLE_PAGE_SIZE)
          ? MAX_AGENT_KEY_BUNDLE_PAGE_SIZE
          : Number(limit);

      const actor = getOwnedActorForRead(tx, agentDbId);
      const visibleAgentIds = buildVisibleAgentIdsForInbox(tx, actor.inboxId);
      if (!visibleAgentIds.has(peerAgentDbId)) {
        throw new SenderError('Peer agent is not visible to this actor');
      }

      repairPendingAgentKeyBundleSortKeys(tx, peerAgentDbId);
      let cursorSortKey: string | undefined;
      if (beforeBundleId !== undefined) {
        const cursorBundle = tx.db.agentKeyBundle.id.find(beforeBundleId);
        if (!cursorBundle || cursorBundle.agentDbId !== peerAgentDbId) {
          throw new SenderError('beforeBundleId is not valid for this peer agent');
        }
        cursorSortKey = buildAgentKeyBundleSortKey(cursorBundle);
      }
      const peerBundlePrefixRange = [peerAgentDbId] as unknown as Parameters<
        typeof tx.db.agentKeyBundle.agent_key_bundle_agent_db_id_sort_key.filter
      >[0];
      const bundles =
        tx.db.agentKeyBundle.agent_key_bundle_agent_db_id_sort_key.filter(peerBundlePrefixRange);
      const rows: model.AgentKeyBundleRow[] = [];
      for (const bundle of bundles) {
        if (cursorSortKey !== undefined && bundle.sortKey <= cursorSortKey) {
          continue;
        }
        rows.push(bundle);
        if (rows.length >= pageSize) {
          break;
        }
      }
      return rows;
    });
  }
);

export const lookupPublishedAgentSigningKeys = spacetimedb.procedure(
  {
    requests: t.array(PublishedAgentSigningKeyLookupRequest),
  },
  t.array(PublishedAgentSigningKeyLookupRow),
  (ctx, { requests }) => {
    return ctx.withTx(tx => {
      requireMaxArrayLength(requests, MAX_CHANNEL_MESSAGE_PAGE_SIZE, 'requests');

      const seen = new Set<string>();
      const resolved: Array<{
        agentDbId: bigint;
        publicIdentity: string;
        signingKeyVersion: string;
        signingPublicKey: string;
      }> = [];

      for (const request of requests) {
        const signingKeyVersion = requireNonEmpty(request.signingKeyVersion, 'signingKeyVersion');
        requireMaxLength(signingKeyVersion, MAX_MESSAGE_VERSION_CHARS, 'signingKeyVersion');

        const requestKey = `${request.agentDbId.toString()}:${signingKeyVersion}`;
        if (seen.has(requestKey)) {
          continue;
        }
        seen.add(requestKey);

        const actor = tx.db.agent.id.find(request.agentDbId);
        if (actor && actor.currentSigningKeyVersion === signingKeyVersion) {
          resolved.push({
            agentDbId: actor.id,
            publicIdentity: actor.publicIdentity,
            signingKeyVersion,
            signingPublicKey: actor.currentSigningPublicKey,
          });
          continue;
        }

        const bundle =
          Array.from(
            tx.db.agentKeyBundle.agent_key_bundle_agent_db_id_signing_key_version.filter([
              request.agentDbId,
              signingKeyVersion,
            ])
          )[0] ?? null;
        if (!bundle) {
          continue;
        }

        resolved.push({
          agentDbId: bundle.agentDbId,
          publicIdentity: bundle.publicIdentity,
          signingKeyVersion: bundle.signingKeyVersion,
          signingPublicKey: bundle.signingPublicKey,
        });
      }

      return resolved;
    });
  }
);

export const rotateAgentKeys = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
      deviceKeyBundles: t.array(DeviceKeyBundleAttachment).optional(),
      revokeDeviceIds: t.array(t.string()).optional(),
  },
  (
    ctx,
    {
        agentDbId,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
        deviceKeyBundles,
        revokeDeviceIds,
    }
  ) => {
    requireMaxArrayLength(deviceKeyBundles ?? [], MAX_THREAD_FANOUT, 'deviceKeyBundles');
    requireMaxArrayLength(revokeDeviceIds ?? [], MAX_THREAD_FANOUT, 'revokeDeviceIds');

    const { actor, inbox } = getOwnedActorWithInbox(ctx, agentDbId);
    refreshInboxAuthLeaseForInbox(ctx, inbox);
    const rotateAllowed = enforceRateLimit(ctx, {
      bucketKey: `agent_key_rotate:${ctx.sender.toHexString()}:${actor.id.toString()}`,
      action: 'agent_key_rotate',
      ownerIdentity: ctx.sender,
      now: ctx.timestamp,
      windowMs: AGENT_KEY_ROTATE_RATE_WINDOW_MS,
      maxCount: AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW,
    });
    if (!rotateAllowed) {
      throw new SenderError('Agent key rotation rate limit exceeded; try again later');
    }
    const normalizedEncryptionKey = normalizePublicKey(
      encryptionPublicKey,
      'encryptionPublicKey'
    );
      const normalizedEncryptionVersion = requireNonEmpty(
        encryptionKeyVersion,
        'encryptionKeyVersion'
      );
      const normalizedEncryptionAlgorithm = normalizeOptionalAlgorithm(
        encryptionAlgorithm,
        DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
        'encryptionAlgorithm'
      );
      const normalizedSigningKey = normalizePublicKey(signingPublicKey, 'signingPublicKey');
      const normalizedSigningVersion = requireNonEmpty(
        signingKeyVersion,
        'signingKeyVersion'
      );
      const normalizedSigningAlgorithm = normalizeOptionalAlgorithm(
        signingAlgorithm,
        DEFAULT_AGENT_SIGNING_ALGORITHM,
        'signingAlgorithm'
      );

    if (
      normalizedEncryptionVersion === actor.currentEncryptionKeyVersion &&
      normalizedSigningVersion === actor.currentSigningKeyVersion
    ) {
      throw new SenderError('New key versions must differ from the current key versions');
    }

    const encryptionMaterialChanged =
      actor.currentEncryptionPublicKey !== normalizedEncryptionKey ||
      actor.currentEncryptionAlgorithm !== normalizedEncryptionAlgorithm;
    const signingMaterialChanged =
      actor.currentSigningPublicKey !== normalizedSigningKey ||
      actor.currentSigningAlgorithm !== normalizedSigningAlgorithm;
    const encryptionVersionChanged =
      normalizedEncryptionVersion !== actor.currentEncryptionKeyVersion;
    const signingVersionChanged =
      normalizedSigningVersion !== actor.currentSigningKeyVersion;

    if (encryptionMaterialChanged && !encryptionVersionChanged) {
      throw new SenderError(
        'encryptionKeyVersion must change when encryption key material or algorithm changes'
      );
    }
    if (signingMaterialChanged && !signingVersionChanged) {
      throw new SenderError(
        'signingKeyVersion must change when signing key material or algorithm changes'
      );
    }

    const existingKeyBundles = Array.from(
      ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(actor.id)
    ).filter(bundle => bundle.agentDbId === actor.id);

    const hasSameKeyBundle = existingKeyBundles.some(bundle => {
      return (
        bundle.encryptionKeyVersion === normalizedEncryptionVersion &&
        bundle.encryptionAlgorithm === normalizedEncryptionAlgorithm &&
        bundle.signingKeyVersion === normalizedSigningVersion &&
        bundle.signingAlgorithm === normalizedSigningAlgorithm &&
        bundle.encryptionPublicKey === normalizedEncryptionKey &&
        bundle.signingPublicKey === normalizedSigningKey
      );
    });

    if (hasSameKeyBundle) {
      throw new SenderError('This key bundle is already registered for the actor');
    }

    const conflictingEncryptionVersion = existingKeyBundles.find(bundle => {
      return (
        bundle.encryptionKeyVersion === normalizedEncryptionVersion &&
        (bundle.encryptionPublicKey !== normalizedEncryptionKey ||
          bundle.encryptionAlgorithm !== normalizedEncryptionAlgorithm)
      );
    });
    if (conflictingEncryptionVersion) {
      throw new SenderError(
        'encryptionKeyVersion is already registered with different encryption key material'
      );
    }

    const conflictingSigningVersion = existingKeyBundles.find(bundle => {
      return (
        bundle.signingKeyVersion === normalizedSigningVersion &&
        (bundle.signingPublicKey !== normalizedSigningKey ||
          bundle.signingAlgorithm !== normalizedSigningAlgorithm)
      );
    });
    if (conflictingSigningVersion) {
      throw new SenderError(
        'signingKeyVersion is already registered with different signing key material'
      );
    }

    const normalizedRevokeDeviceIds = Array.from(
      new Set((revokeDeviceIds ?? []).map(deviceId => normalizeDeviceId(deviceId)))
    );

    ctx.db.agent.id.update({
        ...actor,
        currentEncryptionPublicKey: normalizedEncryptionKey,
        currentEncryptionKeyVersion: normalizedEncryptionVersion,
        currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
        currentSigningPublicKey: normalizedSigningKey,
        currentSigningKeyVersion: normalizedSigningVersion,
        currentSigningAlgorithm: normalizedSigningAlgorithm,
        updatedAt: ctx.timestamp,
    });

    const createdKeyBundle = ctx.db.agentKeyBundle.insert({
      id: 0n,
      agentDbId: actor.id,
        publicIdentity: actor.publicIdentity,
        uniqueKey: buildAgentKeyBundleKey(
          actor.id,
          normalizedEncryptionVersion,
          normalizedSigningVersion
        ),
        encryptionPublicKey: normalizedEncryptionKey,
        encryptionKeyVersion: normalizedEncryptionVersion,
        encryptionAlgorithm: normalizedEncryptionAlgorithm,
        signingPublicKey: normalizedSigningKey,
        signingKeyVersion: normalizedSigningVersion,
        signingAlgorithm: normalizedSigningAlgorithm,
        createdAt: ctx.timestamp,
        sortKey: 'pending',
    });
    ctx.db.agentKeyBundle.id.update({
      ...createdKeyBundle,
      sortKey: buildAgentKeyBundleSortKey(createdKeyBundle),
    });

    for (const deviceId of normalizedRevokeDeviceIds) {
      const device = getOwnedDevice(ctx, deviceId);
      invalidatePendingDeviceShareRequests(ctx, device.inboxId, device.deviceId);
      invalidatePendingDeviceKeyBundles(ctx, device.inboxId, device.deviceId);
      ctx.db.device.id.update({
        ...device,
        status: normalizeDeviceStatus('revoked'),
        revokedAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
        lastSeenAt: ctx.timestamp,
      });
    }

      for (const attachment of deviceKeyBundles ?? []) {
      const normalizedTargetDeviceId = normalizeDeviceId(attachment.deviceId);
      if (normalizedRevokeDeviceIds.includes(normalizedTargetDeviceId)) {
        throw new SenderError(`Cannot share rotated keys to revoked device ${normalizedTargetDeviceId}`);
      }

      insertDeviceKeyBundle(ctx, {
        deviceId: normalizedTargetDeviceId,
          sourceDeviceId: attachment.sourceDeviceId,
          sourceEncryptionPublicKey: attachment.sourceEncryptionPublicKey,
          sourceEncryptionKeyVersion: attachment.sourceEncryptionKeyVersion,
          sourceEncryptionAlgorithm: attachment.sourceEncryptionAlgorithm,
          bundleCiphertext: attachment.bundleCiphertext,
        bundleIv: attachment.bundleIv,
        bundleAlgorithm: attachment.bundleAlgorithm,
        sharedAgentCount: attachment.sharedAgentCount,
        sharedKeyVersionCount: attachment.sharedKeyVersionCount,
        expiresAt: attachment.expiresAt,
        expiryMode: attachment.expiryMode,
      });
    }
  }
);
