import { t, SenderError } from 'spacetimedb/server';
import spacetimedb from '../../schema';
import { inboxAuthLeaseExpiryTable } from '../../tables/inbox-auth-lease-expiry';

import * as model from '../../model';

const {
  DEFAULT_AGENT_ENCRYPTION_ALGORITHM,
  DEFAULT_AGENT_SIGNING_ALGORITHM,
  VisibleInboxRow,
  normalizeCustomInboxSlug,
  normalizeExplicitDefaultInboxSlug,
  buildPublicIdentity,
  buildDefaultSlug,
  requireAvailableSlug,
  requireNonEmpty,
  normalizePublicKey,
  normalizeOptionalDisplayName,
  isTimestampExpired,
  normalizeOptionalAlgorithm,
  requireOidcIdentityClaims,
  getInboxByNormalizedEmail,
  getInboxByOwnerIdentity,
  buildInboxAuthIdentityKey,
  deactivateSenderInboxAuthLease,
  isExpectedInboxAuthLeaseRefreshError,
  upsertInboxAuthLease,
  refreshInboxAuthLeaseForInbox,
  buildAgentKeyBundleKey,
  buildAgentKeyBundleSortKey,
  getDefaultInboxIdentity,
  getRequiredInboxById,
  getOwnedInboxAnyStatus,
  getReadableInbox,
  requireVerifiedInbox,
  getOwnedInbox,
  upsertInboxDevice,
} = model;
export const visibleInboxes = spacetimedb.view(
  { public: true },
  t.array(VisibleInboxRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    return inbox ? [inbox] : [];
  }
);

export const expireInboxAuthLease = spacetimedb.reducer(
  { arg: inboxAuthLeaseExpiryTable.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) {
      throw new SenderError('This reducer can only be called by the scheduler');
    }

    const lease = ctx.db.inboxAuthLease.id.find(arg.leaseId);
    ctx.db.inboxAuthLeaseExpiry.delete(arg);
    if (!lease || !lease.active) {
      return;
    }
    if (
      lease.ownerIdentity.toHexString() !== arg.ownerIdentity.toHexString() ||
      lease.expiresAt.microsSinceUnixEpoch !== arg.expiresAt.microsSinceUnixEpoch ||
      !isTimestampExpired(lease.expiresAt, ctx.timestamp)
    ) {
      return;
    }

    ctx.db.inboxAuthLease.id.update({
      ...lease,
      active: false,
      updatedAt: ctx.timestamp,
    });
  }
);

export const clientConnected = spacetimedb.clientConnected(ctx => {
  const inbox = getInboxByOwnerIdentity(ctx);
  if (!inbox) {
    return;
  }
  try {
    refreshInboxAuthLeaseForInbox(ctx, inbox);
  } catch (error) {
    if (isExpectedInboxAuthLeaseRefreshError(error)) {
      deactivateSenderInboxAuthLease(ctx);
      return;
    }
    throw error;
  }
});

export const refreshInboxAuthLease = spacetimedb.reducer(ctx => {
  const inbox = getOwnedInboxAnyStatus(ctx);
  requireVerifiedInbox(inbox);
  refreshInboxAuthLeaseForInbox(ctx, inbox);
});

export const upsertInboxFromOidcIdentity = spacetimedb.reducer(
  {
    displayName: t.string().optional(),
    defaultSlug: t.string().optional(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
      deviceId: t.string(),
    deviceLabel: t.string().optional(),
    devicePlatform: t.string().optional(),
      deviceEncryptionPublicKey: t.string(),
      deviceEncryptionKeyVersion: t.string(),
      deviceEncryptionAlgorithm: t.string().optional(),
    },
  (
    ctx,
    {
      displayName,
      defaultSlug,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
        deviceId,
      deviceLabel,
      devicePlatform,
        deviceEncryptionPublicKey,
        deviceEncryptionKeyVersion,
        deviceEncryptionAlgorithm,
      }
  ) => {
    const oidcClaims = requireOidcIdentityClaims(ctx);
    const normalizedDisplayName =
      normalizeOptionalDisplayName(displayName) ??
      normalizeOptionalDisplayName(oidcClaims.displayName) ??
      undefined;
    const normalizedDefaultSlug = defaultSlug?.trim()
      ? normalizeExplicitDefaultInboxSlug(defaultSlug)
      : undefined;
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

    const existingByEmail = getInboxByNormalizedEmail(
      ctx,
      oidcClaims.normalizedEmail
    );
    const existingByOwner = getInboxByOwnerIdentity(ctx);

    if (
      existingByEmail &&
      existingByEmail.ownerIdentity.toHexString() !== ctx.sender.toHexString()
    ) {
      throw new SenderError('This email inbox is already owned by another identity');
    }
    if (
      existingByEmail &&
      (existingByEmail.authIssuer !== oidcClaims.issuer ||
        existingByEmail.authSubject !== oidcClaims.subject)
    ) {
      throw new SenderError('This email inbox is already bound to a different OIDC identity');
    }
    if (
      existingByOwner &&
      existingByOwner.normalizedEmail !== oidcClaims.normalizedEmail
    ) {
      throw new SenderError(
        'This OIDC identity is already bound to a different email namespace'
      );
    }
    if (
      existingByOwner &&
      (existingByOwner.authIssuer !== oidcClaims.issuer ||
        existingByOwner.authSubject !== oidcClaims.subject)
    ) {
      throw new SenderError('This Spacetime identity is already bound to a different OIDC identity');
    }

    const inbox =
      existingByEmail ??
      (existingByOwner
        ? existingByOwner
        : ctx.db.inbox.insert({
            id: 0n,
            normalizedEmail: oidcClaims.normalizedEmail,
            displayEmail: oidcClaims.displayEmail,
            ownerIdentity: ctx.sender,
            authSubject: oidcClaims.subject,
            authIssuer: oidcClaims.issuer,
            authIdentityKey: buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject),
            authVerified: true,
            emailAttested: true,
            authVerifiedAt: ctx.timestamp,
            authExpiresAt: oidcClaims.expiresAt,
            createdAt: ctx.timestamp,
            updatedAt: ctx.timestamp,
          }));

    if (existingByEmail || existingByOwner) {
      ctx.db.inbox.id.update({
        ...inbox,
        displayEmail: oidcClaims.displayEmail,
        authSubject: oidcClaims.subject,
        authIssuer: oidcClaims.issuer,
        authIdentityKey: buildInboxAuthIdentityKey(oidcClaims.issuer, oidcClaims.subject),
        authVerified: true,
        emailAttested: true,
        authVerifiedAt: ctx.timestamp,
        authExpiresAt: oidcClaims.expiresAt,
        updatedAt: ctx.timestamp,
      });
    }

    upsertInboxAuthLease(ctx, getRequiredInboxById(ctx, inbox.id), oidcClaims);

    const defaultInboxActor = getDefaultInboxIdentity(ctx, inbox.id);
    const inboxActor = defaultInboxActor;
    if (!inboxActor) {
      const slug = requireAvailableSlug(
        ctx,
        normalizedDefaultSlug ?? buildDefaultSlug(ctx, oidcClaims.normalizedEmail)
      );
      const createdInboxActor = ctx.db.agent.insert({
        id: 0n,
        inboxId: inbox.id,
        normalizedEmail: oidcClaims.normalizedEmail,
        slug,
        inboxIdentifier: undefined,
        isDefault: true,
        publicIdentity: buildPublicIdentity(slug),
        displayName: normalizedDisplayName,
        publicLinkedEmailEnabled: true,
        publicDescription: undefined,
        allowAllMessageContentTypes: true,
        allowAllMessageHeaders: true,
        supportedMessageContentTypes: [],
        supportedMessageHeaderNames: [],
          currentEncryptionPublicKey: normalizedEncryptionKey,
          currentEncryptionKeyVersion: normalizedEncryptionVersion,
          currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
          currentSigningPublicKey: normalizedSigningKey,
          currentSigningKeyVersion: normalizedSigningVersion,
          currentSigningAlgorithm: normalizedSigningAlgorithm,
        masumiRegistrationNetwork: undefined,
        masumiInboxAgentId: undefined,
        masumiAgentIdentifier: undefined,
        masumiRegistrationState: undefined,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });

      const createdKeyBundle = ctx.db.agentKeyBundle.insert({
        id: 0n,
        agentDbId: createdInboxActor.id,
        publicIdentity: createdInboxActor.publicIdentity,
        uniqueKey: buildAgentKeyBundleKey(
          createdInboxActor.id,
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

      upsertInboxDevice(
        ctx,
        inbox.id,
        {
          deviceId,
          label: deviceLabel,
          platform: devicePlatform,
            deviceEncryptionPublicKey,
            deviceEncryptionKeyVersion,
            deviceEncryptionAlgorithm,
          },
        { autoApprove: true }
      );
      return;
    }

    if (
        inboxActor.currentEncryptionPublicKey !== normalizedEncryptionKey ||
        inboxActor.currentEncryptionKeyVersion !== normalizedEncryptionVersion ||
        inboxActor.currentEncryptionAlgorithm !== normalizedEncryptionAlgorithm ||
        inboxActor.currentSigningPublicKey !== normalizedSigningKey ||
        inboxActor.currentSigningKeyVersion !== normalizedSigningVersion ||
        inboxActor.currentSigningAlgorithm !== normalizedSigningAlgorithm
    ) {
      throw new SenderError(
        'Inbox actor keys do not match the currently registered keys; rotate them explicitly instead'
      );
    }

    if (
      (normalizedDisplayName && normalizedDisplayName !== inboxActor.displayName) ||
      inboxActor.inboxIdentifier !== undefined ||
      !inboxActor.isDefault
    ) {
      ctx.db.agent.id.update({
        ...inboxActor,
        inboxIdentifier: undefined,
        isDefault: true,
        displayName: normalizedDisplayName ?? inboxActor.displayName,
        updatedAt: ctx.timestamp,
      });
    }

    upsertInboxDevice(
      ctx,
      inbox.id,
      {
        deviceId,
        label: deviceLabel,
        platform: devicePlatform,
          deviceEncryptionPublicKey,
          deviceEncryptionKeyVersion,
          deviceEncryptionAlgorithm,
        },
      { autoApprove: true }
    );
  }
);

export const createInboxIdentity = spacetimedb.reducer(
  {
    slug: t.string(),
      displayName: t.string().optional(),
      encryptionPublicKey: t.string(),
      encryptionKeyVersion: t.string(),
      encryptionAlgorithm: t.string().optional(),
      signingPublicKey: t.string(),
      signingKeyVersion: t.string(),
      signingAlgorithm: t.string().optional(),
    },
  (
    ctx,
    {
      slug,
        displayName,
        encryptionPublicKey,
        encryptionKeyVersion,
        encryptionAlgorithm,
        signingPublicKey,
        signingKeyVersion,
        signingAlgorithm,
      }
  ) => {
    const inbox = getOwnedInbox(ctx);
    refreshInboxAuthLeaseForInbox(ctx, inbox);
    const normalizedSlug = requireAvailableSlug(
      ctx,
      normalizeCustomInboxSlug(slug, inbox.normalizedEmail)
    );
    const normalizedDisplayName = normalizeOptionalDisplayName(displayName);
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

    const createdAgent = ctx.db.agent.insert({
      id: 0n,
      inboxId: inbox.id,
      normalizedEmail: inbox.normalizedEmail,
      slug: normalizedSlug,
      inboxIdentifier: normalizedSlug,
      isDefault: false,
      publicIdentity: buildPublicIdentity(normalizedSlug),
      displayName: normalizedDisplayName,
      publicLinkedEmailEnabled: true,
      publicDescription: undefined,
      allowAllMessageContentTypes: true,
      allowAllMessageHeaders: true,
      supportedMessageContentTypes: [],
      supportedMessageHeaderNames: [],
        currentEncryptionPublicKey: normalizedEncryptionKey,
        currentEncryptionKeyVersion: normalizedEncryptionVersion,
        currentEncryptionAlgorithm: normalizedEncryptionAlgorithm,
        currentSigningPublicKey: normalizedSigningKey,
        currentSigningKeyVersion: normalizedSigningVersion,
        currentSigningAlgorithm: normalizedSigningAlgorithm,
      masumiRegistrationNetwork: undefined,
      masumiInboxAgentId: undefined,
      masumiAgentIdentifier: undefined,
      masumiRegistrationState: undefined,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });

    const createdKeyBundle = ctx.db.agentKeyBundle.insert({
      id: 0n,
      agentDbId: createdAgent.id,
      publicIdentity: createdAgent.publicIdentity,
      uniqueKey: buildAgentKeyBundleKey(
        createdAgent.id,
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
  }
);
