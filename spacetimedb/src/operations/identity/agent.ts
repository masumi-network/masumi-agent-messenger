import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';
import { normalizeInboxSlug } from '../../../../shared/inbox-slug';
import { normalizeSupportedContentTypes, normalizeSupportedHeaderNames } from '../../../../shared/message-format';

import * as model from '../../model';

const {
  EMAIL_LOOKUP_RATE_WINDOW_MS,
  EMAIL_LOOKUP_RATE_MAX_PER_WINDOW,
  VisibleAgentRow,
  PublishedAgentLookupRow,
  PublishedPublicRouteRow,
  normalizeEmail,
  normalizeOptionalDisplayName,
  enforceRateLimit,
  normalizeOptionalMasumiNetwork,
  normalizeOptionalMasumiRegistrationId,
  normalizeOptionalMasumiRegistrationState,
  normalizeOptionalPublicDescription,
  getActorBySlug,
  getPublicActorsByNormalizedEmail,
  toPublishedAgentLookupRow,
  toPublishedPublicRouteRow,
  getReadableInbox,
  getOwnedActor,
  buildLatestVisibleAgentIdsForInbox,
  toSanitizedVisibleAgentRow,
} = model;
export const visibleAgents = spacetimedb.view(
  { public: true },
  t.array(VisibleAgentRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return Array.from(buildLatestVisibleAgentIdsForInbox(ctx, inbox.id))
      .map(agentDbId => ctx.db.agent.id.find(agentDbId))
      .filter((actor): actor is NonNullable<typeof actor> => Boolean(actor))
      .map(actor => toSanitizedVisibleAgentRow(ctx, inbox.id, actor));
  }
);

export const lookupPublishedAgentBySlug = spacetimedb.procedure(
  {
    slug: t.string(),
  },
  t.array(PublishedAgentLookupRow),
  (ctx, { slug }) => {
    return ctx.withTx(tx => {
      const normalizedSlug = normalizeInboxSlug(slug);
      if (!normalizedSlug) {
        return [];
      }

      const actor = getActorBySlug(tx, normalizedSlug);
      if (!actor) {
        return [];
      }

      return [toPublishedAgentLookupRow(actor)];
    });
  }
);

export const lookupPublishedAgentsByEmail = spacetimedb.procedure(
  {
    email: t.string(),
  },
  t.array(PublishedAgentLookupRow),
  (ctx, { email }) => {
    return ctx.withTx(tx => {
      const allowed = enforceRateLimit(tx, {
        bucketKey: `email_lookup:${ctx.sender.toHexString()}`,
        action: 'email_lookup',
        ownerIdentity: ctx.sender,
        now: ctx.timestamp,
        windowMs: EMAIL_LOOKUP_RATE_WINDOW_MS,
        maxCount: EMAIL_LOOKUP_RATE_MAX_PER_WINDOW,
      });
      if (!allowed) {
        return [];
      }

      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !normalizedEmail.includes('@')) {
        return [];
      }

      return getPublicActorsByNormalizedEmail(tx, normalizedEmail).map(
        toPublishedAgentLookupRow
      );
    });
  }
);

export const lookupPublishedPublicRouteBySlug = spacetimedb.procedure(
  {
    slug: t.string(),
  },
  t.array(PublishedPublicRouteRow),
  (ctx, { slug }) => {
    return ctx.withTx(tx => {
      const normalizedSlug = normalizeInboxSlug(slug);
      if (!normalizedSlug) {
        return [];
      }

      const actor = getActorBySlug(tx, normalizedSlug);
      if (!actor) {
        return [];
      }

      const inbox = tx.db.inbox.id.find(actor.inboxId);
      if (!inbox) {
        return [];
      }

      return [toPublishedPublicRouteRow(actor, inbox)];
    });
  }
);

export const upsertMasumiInboxAgentRegistration = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    masumiRegistrationNetwork: t.string().optional(),
    masumiInboxAgentId: t.string().optional(),
    masumiAgentIdentifier: t.string().optional(),
    masumiRegistrationState: t.string().optional(),
  },
  (
    ctx,
    {
      agentDbId,
      masumiRegistrationNetwork,
      masumiInboxAgentId,
      masumiAgentIdentifier,
      masumiRegistrationState,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      masumiRegistrationNetwork: normalizeOptionalMasumiNetwork(masumiRegistrationNetwork),
      masumiInboxAgentId: normalizeOptionalMasumiRegistrationId(
        masumiInboxAgentId,
        'masumiInboxAgentId'
      ),
      masumiAgentIdentifier: normalizeOptionalMasumiRegistrationId(
        masumiAgentIdentifier,
        'masumiAgentIdentifier'
      ),
      masumiRegistrationState: normalizeOptionalMasumiRegistrationState(
        masumiRegistrationState
      ),
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicLinkedEmailVisibility = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    enabled: t.bool(),
  },
  (ctx, { agentDbId, enabled }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      publicLinkedEmailEnabled: enabled,
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicDescription = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    description: t.string().optional(),
  },
  (ctx, { agentDbId, description }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    ctx.db.agent.id.update({
      ...actor,
      publicDescription: normalizeOptionalPublicDescription(description),
      updatedAt: ctx.timestamp,
    });
  }
);

export const updateAgentProfile = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    displayName: t.string().optional(),
    clearDisplayName: t.bool().optional(),
    publicDescription: t.string().optional(),
    clearPublicDescription: t.bool().optional(),
    publicLinkedEmailEnabled: t.bool().optional(),
  },
  (
    ctx,
    {
      agentDbId,
      displayName,
      clearDisplayName,
      publicDescription,
      clearPublicDescription,
      publicLinkedEmailEnabled,
    }
  ) => {
    const actor = getOwnedActor(ctx, agentDbId);

    if (displayName?.trim() && clearDisplayName) {
      throw new SenderError('Choose either displayName or clearDisplayName');
    }
    if (publicDescription?.trim() && clearPublicDescription) {
      throw new SenderError(
        'Choose either publicDescription or clearPublicDescription'
      );
    }

    const nextDisplayName = clearDisplayName
      ? undefined
      : displayName !== undefined
        ? normalizeOptionalDisplayName(displayName)
        : actor.displayName;
    const nextPublicDescription = clearPublicDescription
      ? undefined
      : publicDescription !== undefined
        ? normalizeOptionalPublicDescription(publicDescription)
        : actor.publicDescription;
    const nextPublicLinkedEmailEnabled =
      publicLinkedEmailEnabled ?? actor.publicLinkedEmailEnabled;

    ctx.db.agent.id.update({
      ...actor,
      displayName: nextDisplayName,
      publicDescription: nextPublicDescription,
      publicLinkedEmailEnabled: nextPublicLinkedEmailEnabled,
      updatedAt: ctx.timestamp,
    });
  }
);

export const setAgentPublicMessageCapabilities = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    allowAllContentTypes: t.bool().optional(),
    allowAllHeaders: t.bool().optional(),
    supportedContentTypes: t.array(t.string()),
    supportedHeaders: t.array(t.string()),
  },
  (ctx, { agentDbId, allowAllContentTypes, allowAllHeaders, supportedContentTypes, supportedHeaders }) => {
    const actor = getOwnedActor(ctx, agentDbId);

    let normalizedContentTypes: string[];
    let normalizedHeaders: string[];
    try {
      normalizedContentTypes = normalizeSupportedContentTypes(supportedContentTypes);
      normalizedHeaders = normalizeSupportedHeaderNames(supportedHeaders);
    } catch (error) {
      throw new SenderError(error instanceof Error ? error.message : 'Invalid public message capabilities');
    }

    ctx.db.agent.id.update({
      ...actor,
      allowAllMessageContentTypes:
        normalizedContentTypes.length === 0
          ? true
          : (allowAllContentTypes ?? actor.allowAllMessageContentTypes ?? false),
      allowAllMessageHeaders:
        normalizedHeaders.length === 0
          ? true
          : (allowAllHeaders ?? actor.allowAllMessageHeaders ?? false),
      supportedMessageContentTypes: normalizedContentTypes,
      supportedMessageHeaderNames: normalizedHeaders,
      updatedAt: ctx.timestamp,
    });
  }
);
