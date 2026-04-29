import { normalizeEmail } from '../../../shared/inbox-slug';
import {
  buildDirectInboxEntries,
  findDefaultActorByEmail,
} from '../../../shared/inbox-state';
import type { ResolvedPublishedActor } from '../../../shared/published-actors';
import { ensureAuthenticatedSession } from './auth';
import type { TaskReporter } from './command-runtime';
import { CliError, connectivityError, isCliError, userError } from './errors';
import { resolvePublishedActorLookup } from './published-actor-lookup';
import {
  connectAuthenticated,
  disconnectConnection,
  readLatestMetadataRows,
  readMessageRows,
} from './spacetimedb';

const MAX_LOOKUP_RESULTS = 25;

export type InboxLookupItem = {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  latestMessageAt: string;
  latestThreadId: string;
  threadCount: number;
  newMessages: number;
};

export type DiscoveredInboxLookupItem = {
  slug: string;
  displayName: string | null;
  publicIdentity: string;
  isDefault: boolean;
};

export type InboxLookupResult = {
  authenticated: true;
  connected: true;
  profile: string;
  query: string | null;
  limit: number;
  totalInboxes: number;
  results: InboxLookupItem[];
  discoveredCount: number;
  discoveredResults: DiscoveredInboxLookupItem[];
  discoveryError: string | null;
};

type MessageSnapshot = ReturnType<typeof readMessageRows>;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOOKUP_RESULTS) {
    throw userError(`Limit must be an integer between 1 and ${MAX_LOOKUP_RESULTS}.`, {
      code: 'INVALID_LOOKUP_LIMIT',
    });
  }
  return limit;
}

function normalizeQuery(query: string | undefined): string | null {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function matchesQuery(item: InboxLookupItem, query: string | null): boolean {
  if (!query) return true;
  return [item.slug, item.displayName ?? '', item.publicIdentity].some(value =>
    value.toLowerCase().includes(query)
  );
}

export function buildDiscoveredInboxLookupItems(params: {
  matchedActors: ResolvedPublishedActor[];
  existingPublicIdentities: Set<string>;
  ownedPublicIdentities: Set<string>;
  limit: number;
}): DiscoveredInboxLookupItem[] {
  return params.matchedActors
    .filter(actor => {
      return (
        !params.existingPublicIdentities.has(actor.publicIdentity) &&
        !params.ownedPublicIdentities.has(actor.publicIdentity)
      );
    })
    .slice(0, params.limit)
    .map(actor => ({
      slug: actor.slug,
      displayName: actor.displayName,
      publicIdentity: actor.publicIdentity,
      isDefault: actor.isDefault,
    }));
}

export function buildInboxLookupEntries(params: {
  snapshot: MessageSnapshot;
  normalizedEmail: string;
  profileName?: string;
  query?: string;
  limit?: number;
}): InboxLookupResult {
  const limit = normalizeLimit(params.limit);
  const query = normalizeQuery(params.query);
  const defaultActor = findDefaultActorByEmail(
    params.snapshot.actors,
    params.normalizedEmail
  );
  if (!defaultActor) {
    throw userError('No default agent found. Run `masumi-agent-messenger account sync` first.', {
      code: 'INBOX_BOOTSTRAP_REQUIRED',
    });
  }

  const matched = buildDirectInboxEntries({
    actors: params.snapshot.actors,
    threads: params.snapshot.threads,
    participants: params.snapshot.participants,
    readStates: params.snapshot.readStates,
    ownInboxId: defaultActor.inboxId,
    dateFormat: 'iso',
  })
    .map(entry => ({
      slug: entry.actor.slug,
      displayName: entry.actor.displayName ?? null,
      publicIdentity: entry.actor.publicIdentity,
      latestMessageAt: entry.latestMessageAt ?? '',
      latestMessageAtValue: entry.latestMessageAtMicros ?? 0n,
      latestThreadIdValue: entry.latestThreadId ?? 0n,
      latestThreadId: entry.latestThreadId?.toString() ?? '0',
      threadCount: entry.threadCount,
      newMessages: entry.newMessages,
    }))
    .filter(item => matchesQuery(item, query))
    .sort((left, right) => {
      if (left.latestMessageAtValue > right.latestMessageAtValue) return -1;
      if (left.latestMessageAtValue < right.latestMessageAtValue) return 1;
      return left.slug.localeCompare(right.slug);
    });

  const results = matched
    .slice(0, limit)
    .map(({ latestMessageAtValue: _latestMessageAtValue, latestThreadIdValue: _latestThreadIdValue, ...item }) => item);

  return {
    authenticated: true,
    connected: true,
    profile: params.profileName ?? 'default',
    query,
    limit,
    totalInboxes: matched.length,
    results,
    discoveredCount: 0,
    discoveredResults: [],
    discoveryError: null,
  };
}

export async function lookupInboxes(params: {
  profileName: string;
  query?: string;
  limit?: number;
  reporter: TaskReporter;
}): Promise<InboxLookupResult> {
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
    params.reporter.verbose?.('Reading latest inbox message state');
    params.reporter.verbose?.('Collecting inboxes');
    const snapshot = await readLatestMetadataRows(conn, { normalizedEmail });
    const result = buildInboxLookupEntries({
      snapshot,
      normalizedEmail,
      profileName: profile.name,
      query: params.query,
      limit: params.limit,
    });
    const defaultActor = findDefaultActorByEmail(snapshot.actors, normalizedEmail);
    const ownPublicIdentities = new Set(
      snapshot.actors
        .filter(actor => actor.inboxId === defaultActor?.inboxId)
        .map(actor => actor.publicIdentity)
    );
    const existingPublicIdentities = new Set(
      result.results.map(item => item.publicIdentity)
    );
    let discoveredResults: DiscoveredInboxLookupItem[] = [];
    let discoveryError: string | null = null;

    if (params.query?.trim()) {
      try {
        const lookup = await resolvePublishedActorLookup({
          identifier: params.query,
          lookupBySlug: input => conn.procedures.lookupPublishedAgentBySlug(input),
          lookupByEmail: input => conn.procedures.lookupPublishedAgentsByEmail(input),
          invalidMessage: 'Inbox slug or email is invalid.',
          invalidCode: 'INVALID_AGENT_IDENTIFIER',
          notFoundCode: 'ACTOR_NOT_FOUND',
          fallbackMessage: 'Unable to search verified inbox agents.',
        });
        discoveredResults = buildDiscoveredInboxLookupItems({
          matchedActors: lookup.matchedActors,
          existingPublicIdentities,
          ownedPublicIdentities: ownPublicIdentities,
          limit: result.limit,
        });
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.code === 'INVALID_AGENT_IDENTIFIER' || error.code === 'ACTOR_NOT_FOUND')
        ) {
          discoveredResults = [];
        } else {
          discoveryError =
            error instanceof Error
              ? error.message
              : 'Unable to search verified inbox agents.';
        }
      }
    }

    params.reporter.success(
      `Loaded ${result.totalInboxes} inbox${result.totalInboxes === 1 ? '' : 'es'}`
    );

    return {
      ...result,
      discoveredCount: discoveredResults.length,
      discoveredResults,
      discoveryError,
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to load inbox lookup.', {
      code: 'INBOX_LOOKUP_FAILED',
      cause: error,
    });
  } finally {
    disconnectConnection(conn);
  }
}
