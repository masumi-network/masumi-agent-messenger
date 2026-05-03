import { normalizeEmail } from '../../../shared/inbox-slug';
import {
  isMasumiInboxAgentState,
  registrationResultFromMetadata,
  type MasumiActorRegistrationMetadata,
  type MasumiRegistrationResult,
} from '../../../shared/inbox-agent-registration';
import type { Agent } from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  applyRegistrationMetadataToActor,
  syncMasumiInboxAgentRegistration,
} from './masumi-inbox-agent';
import {
  connectAuthenticated,
  disconnectConnection,
  readAccounts,
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
  registration: MasumiRegistrationResult;
};

export type OwnedInboxAgentsResult = {
  authenticated: true;
  connected: true;
  profile: string;
  totalAgents: number;
  agents: OwnedInboxAgent[];
};

function sortOwnedAgentRows(left: Agent, right: Agent): number {
  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }
  return left.slug.localeCompare(right.slug);
}

function rowStateTagToGranular(
  state: Agent['masumiRegistrationState']
): string | undefined {
  if (!state) return undefined;
  switch (state.tag) {
    case 'PendingRegistration':
      return 'RegistrationRequested';
    case 'Registered':
      return 'RegistrationConfirmed';
    case 'PendingDeregistration':
      return 'DeregistrationRequested';
    case 'Deregistered':
      return 'DeregistrationConfirmed';
    case 'Failed':
      return 'RegistrationFailed';
    default:
      return undefined;
  }
}

function readActorRegistrationMetadata(
  actor: Agent
): MasumiActorRegistrationMetadata | null {
  const granularState = rowStateTagToGranular(actor.masumiRegistrationState);
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState:
      granularState && isMasumiInboxAgentState(granularState) ? granularState : undefined,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

function selectOwnedActorRows(
  actors: Agent[],
  email: string
): Agent[] {
  const defaultActor = actors.find(
    actor => actor.email === email && actor.isDefault
  );
  const ownInboxId = defaultActor?.accountId ?? null;

  return actors
    .filter(actor =>
      ownInboxId !== null
        ? actor.accountId === ownInboxId
        : actor.email === email
    )
    .sort(sortOwnedAgentRows);
}

function toOwnedInboxAgent(actor: Agent): OwnedInboxAgent {
  const metadata = readActorRegistrationMetadata(actor);
  const registration = registrationResultFromMetadata(metadata);
  return {
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    managed: metadata !== null,
    agentIdentifier: actor.masumiAgentIdentifier ?? null,
    registrationState: actor.masumiRegistrationState?.tag ?? null,
    registration,
  };
}

export function buildOwnedInboxAgents(
  actors: Agent[],
  email: string
): OwnedInboxAgent[] {
  return selectOwnedActorRows(actors, email).map(toOwnedInboxAgent);
}

export async function listOwnedInboxAgents(params: {
  profileName: string;
  reporter: TaskReporter;
}): Promise<OwnedInboxAgentsResult> {
  const { profile, session, claims } = await ensureAuthenticatedSession(params);
  const email = normalizeEmail(claims.email ?? '');
  if (!email) {
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
      const { actors } = await readAccounts(conn);
      const ownedRows = selectOwnedActorRows(actors, email);
      const refreshedRows: Agent[] = [];

      for (const actor of ownedRows) {
        const syncedRegistration = await syncMasumiInboxAgentRegistration({
          profile,
          session,
          conn,
          actor,
          reporter: params.reporter,
          mode: 'skip',
        });
        refreshedRows.push(
          applyRegistrationMetadataToActor(actor, syncedRegistration.metadata)
        );
      }

      const ownedActors = refreshedRows.map(toOwnedInboxAgent);

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
