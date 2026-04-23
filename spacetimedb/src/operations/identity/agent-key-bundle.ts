import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  MAX_THREAD_FANOUT,
  DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
  DEFAULT_AGENT_SIGNING_ALGORITHM,
  AGENT_KEY_ROTATE_RATE_WINDOW_MS,
  AGENT_KEY_ROTATE_RATE_MAX_PER_WINDOW,
  DeviceKeyBundleAttachment,
  VisibleAgentKeyBundleRow,
  enforceRateLimit,
  requireNonEmpty,
  normalizePublicKey,
  normalizeDeviceId,
  normalizeDeviceStatus,
  normalizeOptionalAlgorithm,
  requireMaxArrayLength,
  refreshInboxAuthLeaseForInbox,
  buildAgentKeyBundleKey,
  getReadableInbox,
  getOwnedActorWithInbox,
  buildVisibleAgentIdsForInbox,
  getOwnedDevice,
  invalidatePendingDeviceShareRequests,
  invalidatePendingDeviceKeyBundles,
  insertDeviceKeyBundle,
} = model;
export const visibleAgentKeyBundles = spacetimedb.view(
  { public: true },
  t.array(VisibleAgentKeyBundleRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildVisibleAgentIdsForInbox(ctx, inbox.id)).flatMap(agentDbId =>
      Array.from(ctx.db.agentKeyBundle.agent_key_bundle_agent_db_id.filter(agentDbId))
    );
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

    ctx.db.agentKeyBundle.insert({
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
