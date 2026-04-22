import { t, SenderError } from 'spacetimedb/server';

import spacetimedb from '../../schema';

import * as model from '../../model';

const {
  VisibleContactAllowlistEntryRow,
  normalizePublicIdentity,
  requireValidEmail,
  normalizeContactAllowlistKind,
  getContactAllowlistEntriesByInboxId,
  buildContactAllowlistEntryKey,
  getRequiredActorByPublicIdentity,
  getRequiredContactAllowlistEntryByRowId,
  getReadableInbox,
  getOwnedInbox,
  getOwnedActor,
} = model;
export const visibleContactAllowlistEntries = spacetimedb.view(
  { public: true },
  t.array(VisibleContactAllowlistEntryRow),
  ctx => {
    const inbox = getReadableInbox(ctx);
    if (!inbox) {
      return [];
    }

    return getContactAllowlistEntriesByInboxId(ctx, inbox.id)
      .map(entry => ({
        id: entry.id,
        inboxId: entry.inboxId,
        kind: entry.kind.tag,
        agentPublicIdentity: entry.agentPublicIdentity,
        agentSlug: entry.agentSlug,
        agentDisplayName: entry.agentDisplayName,
        normalizedEmail: entry.normalizedEmail,
        displayEmail: entry.displayEmail,
        createdByAgentDbId: entry.createdByAgentDbId,
        createdAt: entry.createdAt,
      }));
  }
);

export const addContactAllowlistEntry = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    agentPublicIdentity: t.string().optional(),
    email: t.string().optional(),
  },
  (ctx, { agentDbId, agentPublicIdentity, email }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const inbox = getOwnedInbox(ctx);
    const normalizedAgentPublicIdentity = agentPublicIdentity?.trim()
      ? normalizePublicIdentity(agentPublicIdentity)
      : undefined;
    const trimmedEmail = email?.trim();
    const normalizedEmail = trimmedEmail ? requireValidEmail(trimmedEmail, 'email') : undefined;
    const displayEmailInput = trimmedEmail || undefined;

    if (Boolean(normalizedAgentPublicIdentity) === Boolean(normalizedEmail)) {
      throw new SenderError('Provide exactly one contact allowlist value');
    }

    const existingEntries = getContactAllowlistEntriesByInboxId(ctx, inbox.id);

    if (normalizedAgentPublicIdentity) {
      const targetActor = getRequiredActorByPublicIdentity(ctx, normalizedAgentPublicIdentity);
      const existing = existingEntries.find(entry => {
        return (
          entry.inboxId === inbox.id &&
          entry.kind.tag === 'agent' &&
          entry.agentPublicIdentity === targetActor.publicIdentity
        );
      });
      if (existing) {
        return;
      }

      const agentKind = normalizeContactAllowlistKind('agent');
      ctx.db.contactAllowlistEntry.insert({
        id: 0n,
        inboxId: inbox.id,
        kind: agentKind,
        uniqueKey: buildContactAllowlistEntryKey(
          inbox.id,
          agentKind.tag,
          targetActor.publicIdentity,
          undefined
        ),
        agentPublicIdentity: targetActor.publicIdentity,
        agentSlug: targetActor.slug,
        agentDisplayName: targetActor.displayName,
        normalizedEmail: undefined,
        displayEmail: undefined,
        createdByAgentDbId: actor.id,
        createdAt: ctx.timestamp,
      });
      return;
    }

    const existing = existingEntries.find(entry => {
      return (
        entry.inboxId === inbox.id &&
        entry.kind.tag === 'email' &&
        entry.normalizedEmail === normalizedEmail
      );
    });
    if (existing) {
      return;
    }

    const emailKind = normalizeContactAllowlistKind('email');
    ctx.db.contactAllowlistEntry.insert({
      id: 0n,
      inboxId: inbox.id,
      kind: emailKind,
      uniqueKey: buildContactAllowlistEntryKey(inbox.id, emailKind.tag, undefined, normalizedEmail),
      agentPublicIdentity: undefined,
      agentSlug: undefined,
      agentDisplayName: undefined,
      normalizedEmail,
      displayEmail: displayEmailInput ?? normalizedEmail,
      createdByAgentDbId: actor.id,
      createdAt: ctx.timestamp,
    });
  }
);

export const removeContactAllowlistEntry = spacetimedb.reducer(
  {
    agentDbId: t.u64(),
    entryId: t.u64(),
  },
  (ctx, { agentDbId, entryId }) => {
    const actor = getOwnedActor(ctx, agentDbId);
    const entry = getRequiredContactAllowlistEntryByRowId(ctx, entryId);
    if (entry.inboxId !== actor.inboxId) {
      throw new SenderError('Contact allowlist entry does not belong to this inbox');
    }

    ctx.db.contactAllowlistEntry.id.delete(entryId);
  }
);
