import { normalizeEmail } from '../../../shared/inbox-slug';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  connectAuthenticated,
  disconnectConnection,
  readInboxRows,
  subscribeInboxTables,
} from './spacetimedb';

export type OwnedInboxAgent = {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  isDefault: boolean;
  managed: boolean;
  agentIdentifier: string | null;
  registrationState: string | null;
};

export type OwnedInboxAgentsResult = {
  authenticated: true;
  connected: true;
  profile: string;
  totalAgents: number;
  agents: OwnedInboxAgent[];
};

function sortOwnedAgents(left: OwnedInboxAgent, right: OwnedInboxAgent): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  return left.slug.localeCompare(right.slug);
}

export function buildOwnedInboxAgents(
  actors: VisibleAgentRow[],
  normalizedEmail: string
): OwnedInboxAgent[] {
  const defaultActor = actors.find(
    actor => actor.normalizedEmail === normalizedEmail && actor.isDefault
  );
  const ownInboxId = defaultActor?.inboxId ?? null;

  return actors
    .filter(actor =>
      ownInboxId !== null
        ? actor.inboxId === ownInboxId
        : actor.normalizedEmail === normalizedEmail
    )
    .map(actor => ({
      slug: actor.slug,
      displayName: actor.displayName ?? null,
      publicIdentity: actor.publicIdentity,
      isDefault: actor.isDefault,
      managed: Boolean(actor.masumiAgentIdentifier || actor.masumiInboxAgentId),
      agentIdentifier: actor.masumiAgentIdentifier ?? null,
      registrationState: actor.masumiRegistrationState ?? null,
    }))
    .sort(sortOwnedAgents);
}

export async function listOwnedInboxAgents(params: {
  profileName: string;
  reporter: TaskReporter;
}): Promise<OwnedInboxAgentsResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const normalizedEmail = normalizeEmail(claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: profile.spacetimeHost,
    databaseName: profile.spacetimeDbName,
    sessionToken: session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    params.reporter.verbose?.('Subscribing to inbox state');
    const subscription = await subscribeInboxTables(conn);

    try {
      const { actors } = readInboxRows(conn);
      const ownedActors = buildOwnedInboxAgents(actors, normalizedEmail);

      params.reporter.success(
        `Loaded ${ownedActors.length} owned agent${ownedActors.length === 1 ? '' : 's'}`
      );

      return {
        authenticated: true,
        connected: true,
        profile: profile.name,
        totalAgents: ownedActors.length,
        agents: ownedActors,
      };
    } finally {
      subscription.unsubscribe();
    }
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to load owned inbox agents.', {
      code: 'OWNED_INBOX_AGENTS_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}
