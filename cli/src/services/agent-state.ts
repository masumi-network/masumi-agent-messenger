import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  isDeregisteringOrDeregisteredMasumiRegistrationMetadata,
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
} from '../../../shared/inbox-agent-registration';
import {
  buildLegacyPublicMessageCapabilities,
  buildPublicMessageCapabilities,
  normalizeSupportedContentTypes,
  normalizeSupportedHeaderNames,
} from '../../../shared/message-format';
import type { DbConnection } from '../../../webapp/src/module_bindings';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import {
  loadProfile,
  saveActiveAgentSlug,
  type ResolvedProfile,
} from './config-store';
import { connectivityError, isCliError, userError } from './errors';
import {
  applyRegistrationMetadataToActor,
  syncMasumiInboxAgentRegistration,
} from './masumi-inbox-agent';
import type { StoredOidcSession } from './oidc';
import {
  connectAuthenticated,
  disconnectConnection,
  readInboxRows,
  subscribeInboxTables,
} from './spacetimedb';

export type OwnedAgentSummary = {
  id: string;
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  isDefault: boolean;
  isActive: boolean;
  managed: boolean;
  registered: boolean;
  deregistered: boolean;
};

export type OwnedAgentProfile = OwnedAgentSummary & {
  publicDescription: string | null;
  publicLinkedEmailEnabled: boolean;
  registrationNetwork: string | null;
  agentIdentifier: string | null;
  registrationState: string | null;
  messageCapabilities: OwnedAgentMessageCapabilities;
};

export type OwnedAgentMessageCapabilities = {
  allowAllContentTypes: boolean;
  allowAllHeaders: boolean;
  supportedContentTypes: string[];
  supportedHeaders: string[];
};

export type OwnedAgentListResult = {
  profile: string;
  activeAgentSlug: string | null;
  agents: OwnedAgentSummary[];
};

function resolveStoredActiveAgentSlug(profile: ResolvedProfile): string | null {
  const normalizedActiveSlug = profile.activeAgentSlug
    ? normalizeInboxSlug(profile.activeAgentSlug)
    : null;
  if (normalizedActiveSlug) {
    return normalizedActiveSlug;
  }

  const bootstrapActorSlug = profile.bootstrapSnapshot?.actor.slug;
  return bootstrapActorSlug ? normalizeInboxSlug(bootstrapActorSlug) : null;
}

function requireOwnedActors(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
}): {
  defaultActor: VisibleAgentRow;
  ownedActors: VisibleAgentRow[];
} {
  const defaultActor =
    params.actors.find(actor => actor.normalizedEmail === params.normalizedEmail && actor.isDefault) ??
    null;
  if (!defaultActor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }

  return {
    defaultActor,
    ownedActors: params.actors.filter(actor => actor.inboxId === defaultActor.inboxId),
  };
}

function resolveOwnedActor(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
  actorSlug?: string | null;
  activeAgentSlug?: string | null;
}): VisibleAgentRow {
  const { defaultActor, ownedActors } = requireOwnedActors(params);
  const requestedSlug =
    (params.actorSlug ? normalizeInboxSlug(params.actorSlug) : null) ??
    (params.activeAgentSlug ? normalizeInboxSlug(params.activeAgentSlug) : null) ??
    null;
  if (!requestedSlug) {
    return defaultActor;
  }

  return ownedActors.find(actor => actor.slug === requestedSlug) ?? defaultActor;
}

function requireOwnedActorBySlug(params: {
  actors: VisibleAgentRow[];
  normalizedEmail: string;
  actorSlug: string;
}): VisibleAgentRow {
  const { ownedActors } = requireOwnedActors(params);
  const normalizedSlug = normalizeInboxSlug(params.actorSlug);
  if (!normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const actor = ownedActors.find(candidate => candidate.slug === normalizedSlug);
  if (!actor) {
    throw userError(`No owned agent found for slug \`${normalizedSlug}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }

  return actor;
}

function toOwnedAgentSummary(
  actor: VisibleAgentRow,
  activeAgentSlug: string | null
): OwnedAgentSummary {
  const metadata = readActorRegistrationMetadata(actor);
  const registration = registrationResultFromMetadata(metadata);
  return {
    id: actor.id.toString(),
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    isActive: actor.slug === activeAgentSlug,
    managed: metadata !== null,
    registered: registration.status === 'registered',
    deregistered: isDeregisteredOwnedActor(actor),
  };
}

function isDeregisteredOwnedActor(actor: VisibleAgentRow): boolean {
  return isDeregisteringOrDeregisteredMasumiRegistrationMetadata(
    readActorRegistrationMetadata(actor)
  );
}

function assertActorCanBeActive(actor: VisibleAgentRow): void {
  if (!isDeregisteredOwnedActor(actor)) {
    return;
  }

  throw userError(
    `Agent \`${actor.slug}\` is deregistering or deregistered and cannot be selected as the active agent.`,
    {
      code: 'AGENT_DEREGISTERED',
    }
  );
}

function toOwnedAgentProfile(
  actor: VisibleAgentRow,
  activeAgentSlug: string | null
): OwnedAgentProfile {
  return {
    ...toOwnedAgentSummary(actor, activeAgentSlug),
    publicDescription: actor.publicDescription ?? null,
    publicLinkedEmailEnabled: actor.publicLinkedEmailEnabled,
    registrationNetwork: actor.masumiRegistrationNetwork ?? null,
    agentIdentifier: actor.masumiAgentIdentifier ?? null,
    registrationState: actor.masumiRegistrationState ?? null,
    messageCapabilities: toOwnedAgentMessageCapabilities(actor),
  };
}

function readActorRegistrationMetadata(
  actor: VisibleAgentRow
): MasumiActorRegistrationMetadata | null {
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState:
      actor.masumiRegistrationState && isMasumiInboxAgentState(actor.masumiRegistrationState)
        ? actor.masumiRegistrationState
        : undefined,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

function toOwnedAgentMessageCapabilities(
  actor: VisibleAgentRow
): OwnedAgentMessageCapabilities {
  const capabilities =
    actor.supportedMessageContentTypes && actor.supportedMessageHeaderNames
      ? buildPublicMessageCapabilities({
          allowAllContentTypes:
            actor.allowAllMessageContentTypes ??
            (actor.supportedMessageContentTypes.length === 0),
          allowAllHeaders:
            actor.allowAllMessageHeaders ?? (actor.supportedMessageHeaderNames.length === 0),
          supportedContentTypes: actor.supportedMessageContentTypes,
          supportedHeaders: actor.supportedMessageHeaderNames,
        })
      : buildLegacyPublicMessageCapabilities();

  return {
    allowAllContentTypes: capabilities.allowAllContentTypes,
    allowAllHeaders: capabilities.allowAllHeaders,
    supportedContentTypes: [...capabilities.supportedContentTypes],
    supportedHeaders: capabilities.supportedHeaders.map(header => header.name),
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

async function refreshOwnedAgentRegistration(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  conn: DbConnection;
  actor: VisibleAgentRow;
  reporter: TaskReporter;
}): Promise<VisibleAgentRow> {
  const syncedRegistration = await syncMasumiInboxAgentRegistration({
    profile: params.profile,
    session: params.session,
    conn: params.conn,
    actor: params.actor,
    reporter: params.reporter,
    mode: 'skip',
  });
  return applyRegistrationMetadataToActor(
    params.actor,
    syncedRegistration.metadata
  );
}

export async function resolvePreferredAgentSlug(
  profileName: string,
  explicitAgentSlug?: string | null
): Promise<string | undefined> {
  const normalizedExplicit = explicitAgentSlug ? normalizeInboxSlug(explicitAgentSlug) : null;
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const profile = await loadProfile(profileName);
  return resolveStoredActiveAgentSlug(profile) ?? undefined;
}

export async function listOwnedAgents(params: {
  profileName: string;
  reporter: TaskReporter;
}): Promise<OwnedAgentListResult> {
  const profileState = await loadProfile(params.profileName);
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const activeAgentSlug = resolveStoredActiveAgentSlug(profileState);
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const { ownedActors, defaultActor } = requireOwnedActors({
        actors: readInboxRows(conn).actors,
        normalizedEmail,
      });
      const selectedSlug = activeAgentSlug ?? defaultActor.slug;
      const sortedActors = ownedActors.sort((left, right) => {
        if (left.slug === selectedSlug) return -1;
        if (right.slug === selectedSlug) return 1;
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.slug.localeCompare(right.slug);
      });
      const refreshedActors: VisibleAgentRow[] = [];
      for (const actor of sortedActors) {
        refreshedActors.push(
          await refreshOwnedAgentRegistration({
            profile,
            session,
            conn,
            actor,
            reporter: params.reporter,
          })
        );
      }
      const refreshedActiveSlug =
        refreshedActors.find(
          actor => actor.slug === selectedSlug && !isDeregisteredOwnedActor(actor)
        )?.slug ??
        refreshedActors.find(actor => actor.isDefault && !isDeregisteredOwnedActor(actor))?.slug ??
        refreshedActors.find(actor => !isDeregisteredOwnedActor(actor))?.slug ??
        null;
      if (refreshedActiveSlug && refreshedActiveSlug !== activeAgentSlug) {
        await saveActiveAgentSlug(profile.name, refreshedActiveSlug);
      }
      const agents = refreshedActors.map(actor => toOwnedAgentSummary(actor, refreshedActiveSlug));

      // If every owned agent is deregistered, surface null rather than a
      // stale deregistered slug — downstream callers treat null as
      // "no selectable agent" (matches channel/send guard semantics).
      return {
        profile: profile.name,
        activeAgentSlug: refreshedActiveSlug,
        agents,
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function getOwnedAgentProfile(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string | null;
}): Promise<{
  profile: string;
  activeAgentSlug: string;
  agent: OwnedAgentProfile;
}> {
  const profileState = await loadProfile(params.profileName);
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const snapshot = readInboxRows(conn);
      const actor = resolveOwnedActor({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
        activeAgentSlug: resolveStoredActiveAgentSlug(profileState),
      });
      const requestedActorSlug = params.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
      const activeAgentSlug =
        requestedActorSlug ?? resolveStoredActiveAgentSlug(profileState) ?? actor.slug;
      const refreshedActor = await refreshOwnedAgentRegistration({
        profile,
        session,
        conn,
        actor,
        reporter: params.reporter,
      });
      return {
        profile: profile.name,
        activeAgentSlug,
        agent: toOwnedAgentProfile(refreshedActor, activeAgentSlug),
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function useOwnedAgent(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug: string;
}): Promise<{
  profile: string;
  activeAgentSlug: string;
  agent: OwnedAgentProfile;
}> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const actor = requireOwnedActorBySlug({
        actors: readInboxRows(conn).actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
      });
      const refreshedActor = await refreshOwnedAgentRegistration({
        profile,
        session,
        conn,
        actor,
        reporter: params.reporter,
      });
      assertActorCanBeActive(refreshedActor);
      await saveActiveAgentSlug(profile.name, refreshedActor.slug);
      return {
        profile: profile.name,
        activeAgentSlug: refreshedActor.slug,
        agent: toOwnedAgentProfile(refreshedActor, refreshedActor.slug),
      };
    } finally {
      subscription.unsubscribe();
    }
  } finally {
    disconnectConnection(conn);
  }
}

export async function updateOwnedAgentProfile(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string | null;
  displayName?: string;
  clearDisplayName?: boolean;
  publicDescription?: string;
  clearPublicDescription?: boolean;
  publicLinkedEmailEnabled?: boolean;
}): Promise<{
  profile: string;
  activeAgentSlug: string;
  agent: OwnedAgentProfile;
}> {
  if (
    params.displayName === undefined &&
    !params.clearDisplayName &&
    params.publicDescription === undefined &&
    !params.clearPublicDescription &&
    params.publicLinkedEmailEnabled === undefined
  ) {
    throw userError('Provide at least one profile field to update.', {
      code: 'AGENT_PROFILE_UPDATE_EMPTY',
    });
  }

  const profileState = await loadProfile(params.profileName);
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const read = () => readInboxRows(conn);
      const snapshot = read();
      const actor = resolveOwnedActor({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
        activeAgentSlug: resolveStoredActiveAgentSlug(profileState),
      });
      const expectedDisplayName = params.clearDisplayName
        ? null
        : params.displayName !== undefined
          ? params.displayName.trim() || null
          : actor.displayName ?? null;
      const expectedPublicDescription = params.clearPublicDescription
        ? null
        : params.publicDescription !== undefined
          ? params.publicDescription.trim() || null
          : actor.publicDescription ?? null;
      const expectedLinkedEmailEnabled =
        params.publicLinkedEmailEnabled ?? actor.publicLinkedEmailEnabled;

      await conn.reducers.updateAgentProfile({
        agentDbId: actor.id,
        displayName: params.displayName?.trim() || undefined,
        clearDisplayName: params.clearDisplayName || undefined,
        publicDescription: params.publicDescription?.trim() || undefined,
        clearPublicDescription: params.clearPublicDescription || undefined,
        publicLinkedEmailEnabled: params.publicLinkedEmailEnabled,
      });

      const updatedActor = await new Promise<VisibleAgentRow>((resolve, reject) => {
        const timeoutAt = Date.now() + 10_000;
        const poll = () => {
          const nextActor = read().actors.find(row => row.id === actor.id) ?? null;
          if (
            nextActor &&
            (nextActor.displayName ?? null) === expectedDisplayName &&
            (nextActor.publicDescription ?? null) === expectedPublicDescription &&
            nextActor.publicLinkedEmailEnabled === expectedLinkedEmailEnabled
          ) {
            resolve(nextActor);
            return;
          }
          if (Date.now() >= timeoutAt) {
            reject(
              connectivityError('Timed out waiting for the agent profile to sync.', {
                code: 'AGENT_PROFILE_SYNC_TIMEOUT',
              })
            );
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });

      const requestedActorSlug = params.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
      const activeAgentSlug =
        requestedActorSlug ?? resolveStoredActiveAgentSlug(profileState) ?? updatedActor.slug;
      const refreshedActor = await refreshOwnedAgentRegistration({
        profile,
        session,
        conn,
        actor: updatedActor,
        reporter: params.reporter,
      });
      return {
        profile: profile.name,
        activeAgentSlug,
        agent: toOwnedAgentProfile(refreshedActor, activeAgentSlug),
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to update the agent profile.', {
      code: 'AGENT_PROFILE_UPDATE_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}

export async function updateOwnedAgentMessageCapabilities(params: {
  profileName: string;
  reporter: TaskReporter;
  actorSlug?: string | null;
  allowAllContentTypes?: boolean;
  allowAllHeaders?: boolean;
  supportedContentTypes?: string[];
  supportedHeaders?: string[];
}): Promise<{
  profile: string;
  activeAgentSlug: string;
  agent: OwnedAgentProfile;
}> {
  if (
    params.allowAllContentTypes === undefined &&
    params.allowAllHeaders === undefined &&
    params.supportedContentTypes === undefined &&
    params.supportedHeaders === undefined
  ) {
    throw userError('Provide at least one message capability change.', {
      code: 'AGENT_MESSAGE_CAPABILITIES_EMPTY',
    });
  }

  const profileState = await loadProfile(params.profileName);
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });

  try {
    const subscription = await subscribeInboxTables(conn);
    try {
      const read = () => readInboxRows(conn);
      const snapshot = read();
      const actor = resolveOwnedActor({
        actors: snapshot.actors,
        normalizedEmail,
        actorSlug: params.actorSlug,
        activeAgentSlug: resolveStoredActiveAgentSlug(profileState),
      });
      const currentCapabilities = toOwnedAgentMessageCapabilities(actor);
      const nextSupportedContentTypes =
        params.supportedContentTypes !== undefined
          ? normalizeSupportedContentTypes(params.supportedContentTypes)
          : currentCapabilities.supportedContentTypes;
      const nextSupportedHeaders =
        params.supportedHeaders !== undefined
          ? normalizeSupportedHeaderNames(params.supportedHeaders)
          : currentCapabilities.supportedHeaders;
      const expectedCapabilities: OwnedAgentMessageCapabilities = {
        allowAllContentTypes:
          nextSupportedContentTypes.length === 0
            ? true
            : (params.allowAllContentTypes ?? currentCapabilities.allowAllContentTypes),
        allowAllHeaders:
          nextSupportedHeaders.length === 0
            ? true
            : (params.allowAllHeaders ?? currentCapabilities.allowAllHeaders),
        supportedContentTypes: nextSupportedContentTypes,
        supportedHeaders: nextSupportedHeaders,
      };

      await conn.reducers.setAgentPublicMessageCapabilities({
        agentDbId: actor.id,
        allowAllContentTypes: expectedCapabilities.allowAllContentTypes,
        allowAllHeaders: expectedCapabilities.allowAllHeaders,
        supportedContentTypes: expectedCapabilities.supportedContentTypes,
        supportedHeaders: expectedCapabilities.supportedHeaders,
      });

      const updatedActor = await new Promise<VisibleAgentRow>((resolve, reject) => {
        const timeoutAt = Date.now() + 10_000;
        const poll = () => {
          const nextActor = read().actors.find(row => row.id === actor.id) ?? null;
          if (nextActor) {
            const nextCapabilities = toOwnedAgentMessageCapabilities(nextActor);
            if (
              nextCapabilities.allowAllContentTypes ===
                expectedCapabilities.allowAllContentTypes &&
              nextCapabilities.allowAllHeaders === expectedCapabilities.allowAllHeaders &&
              arraysEqual(
                nextCapabilities.supportedContentTypes,
                expectedCapabilities.supportedContentTypes
              ) &&
              arraysEqual(
                nextCapabilities.supportedHeaders,
                expectedCapabilities.supportedHeaders
              )
            ) {
              resolve(nextActor);
              return;
            }
          }
          if (Date.now() >= timeoutAt) {
            reject(
              connectivityError('Timed out waiting for message capabilities to sync.', {
                code: 'AGENT_MESSAGE_CAPABILITIES_SYNC_TIMEOUT',
              })
            );
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });

      const requestedActorSlug = params.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
      const activeAgentSlug =
        requestedActorSlug ?? resolveStoredActiveAgentSlug(profileState) ?? updatedActor.slug;
      const refreshedActor = await refreshOwnedAgentRegistration({
        profile,
        session,
        conn,
        actor: updatedActor,
        reporter: params.reporter,
      });
      return {
        profile: profile.name,
        activeAgentSlug,
        agent: toOwnedAgentProfile(refreshedActor, activeAgentSlug),
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to update agent message capabilities.', {
      code: 'AGENT_MESSAGE_CAPABILITIES_UPDATE_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}
