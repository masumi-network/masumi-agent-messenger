import type { AuthenticatedBrowserSession } from './auth-session';
import {
  findMasumiInboxAgents,
  listMasumiInboxAgents,
  lookupMasumiInboxAgent,
} from './inbox-agent-registration';
import type { DbConnection } from '@/module_bindings';
import type { PublishedPublicRouteRow } from '@/module_bindings/types';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import {
  DeregisteredInboxAgentError,
  isDeregisteringOrDeregisteredInboxAgentState,
  isFailedRegistrationInboxAgentState,
  type MasumiInboxAgentEntry,
  type MasumiInboxAgentState,
} from '../../../shared/inbox-agent-registration';
import type {
  PublishedActorLookupLike,
  ResolvedPublishedActor,
} from '../../../shared/published-actors';

function toResolvedActor(
  actor: PublishedActorLookupLike,
  fallbackDisplayName?: string | null,
  fallbackEmail?: string | null
): ResolvedPublishedActor {
  return {
    slug: actor.slug,
    publicIdentity: actor.publicIdentity,
    isDefault: actor.isDefault,
    displayName: actor.displayName ?? fallbackDisplayName ?? null,
    linkedEmail: actor.linkedEmail ?? fallbackEmail,
  };
}

function extractEmailFromResult(entry: MasumiInboxAgentEntry): string | null {
  return entry.linkedEmail?.trim() ? entry.linkedEmail.trim() : null;
}

export function selectResolvedPublishedActor(
  matches: ResolvedPublishedActor[],
  identifier: string
): ResolvedPublishedActor {
  const looksLikeEmail = identifier.includes('@');
  const requestedSlug = looksLikeEmail ? '' : normalizeInboxSlug(identifier);

  return (
    (requestedSlug ? matches.find(actor => actor.slug === requestedSlug) ?? null : null) ??
    (looksLikeEmail ? matches.find(actor => actor.isDefault) ?? matches[0] : matches[0])
  );
}

export type DiscoveredNetworkAgent = {
  slug: string;
  displayName: string | null;
  description: string | null;
  agentIdentifier: string | null;
  linkedEmail: string | null;
  registrationState: MasumiInboxAgentState;
};

export type DiscoveredNetworkAgentPage = {
  agents: DiscoveredNetworkAgent[];
  page: number;
  take: number;
  hasNextPage: boolean;
  mode: 'browse' | 'search';
  query: string | null;
};

function dedupeMasumiAgentsBySlug(entries: MasumiInboxAgentEntry[]): MasumiInboxAgentEntry[] {
  const seenSlugs = new Set<string>();
  const deduped: MasumiInboxAgentEntry[] = [];

  for (const entry of entries) {
    const normalizedSlug = normalizeInboxSlug(entry.agentSlug);
    if (!normalizedSlug || seenSlugs.has(normalizedSlug)) {
      continue;
    }

    seenSlugs.add(normalizedSlug);
    deduped.push(entry);
  }

  return deduped;
}

type DiscoveryPublicRoute = Pick<
  PublishedPublicRouteRow,
  'agentIdentifier' | 'description' | 'linkedEmail'
>;

async function lookupPublicRouteForEntry(params: {
  entry: MasumiInboxAgentEntry;
  liveConnection?: DbConnection | null;
}): Promise<DiscoveryPublicRoute | null> {
  if (!params.liveConnection) {
    return null;
  }

  const slug = normalizeInboxSlug(params.entry.agentSlug) ?? params.entry.agentSlug.trim();
  if (!slug) {
    return null;
  }

  try {
    return (
      await params.liveConnection.procedures.lookupPublishedPublicRouteBySlug({
        slug,
      })
    )[0] ?? null;
  } catch {
    return null;
  }
}

function toDiscoveredNetworkAgent(params: {
  entry: MasumiInboxAgentEntry;
  publicRoute?: DiscoveryPublicRoute | null;
}): DiscoveredNetworkAgent {
  const { entry, publicRoute } = params;
  return {
    slug: normalizeInboxSlug(entry.agentSlug) ?? entry.agentSlug.trim(),
    displayName: entry.name ?? null,
    description: publicRoute?.description ?? null,
    agentIdentifier: publicRoute?.agentIdentifier ?? entry.agentIdentifier ?? null,
    linkedEmail: publicRoute?.linkedEmail ?? extractEmailFromResult(entry),
    registrationState: entry.state,
  };
}

export async function discoverMasumiNetworkAgents(params: {
  identifier?: string;
  session: AuthenticatedBrowserSession;
  take?: number;
  page?: number;
  liveConnection?: DbConnection | null;
}): Promise<DiscoveredNetworkAgentPage> {
  const identifier = params.identifier?.trim() ?? '';
  const mode = identifier ? 'search' : 'browse';
  const result = identifier
    ? await findMasumiInboxAgents(params.session, {
        search: identifier,
        take: params.take ?? 20,
        page: params.page,
      })
    : await listMasumiInboxAgents(params.session, {
        take: params.take ?? 20,
        page: params.page,
      });
  const remoteMatches = dedupeMasumiAgentsBySlug(result.agents);

  const agents = await Promise.all(
    remoteMatches.map(async entry =>
      toDiscoveredNetworkAgent({
        entry,
        publicRoute: await lookupPublicRouteForEntry({
          entry,
          liveConnection: params.liveConnection,
        }),
      })
    )
  );

  return {
    agents,
    page: result.page,
    take: result.take,
    hasNextPage: result.hasNextPage,
    mode,
    query: identifier || null,
  };
}

export async function lookupMasumiNetworkAgent(params: {
  slug: string;
  session: AuthenticatedBrowserSession;
  liveConnection?: DbConnection | null;
}): Promise<DiscoveredNetworkAgent | null> {
  const result = await lookupMasumiInboxAgent(params.session, {
    slug: params.slug,
  });
  const entry = result.agents[0] ?? null;
  return entry
    ? toDiscoveredNetworkAgent({
        entry,
        publicRoute: await lookupPublicRouteForEntry({
          entry,
          liveConnection: params.liveConnection,
        }),
    })
    : null;
}

async function getMasumiNetworkAgentChatBlock(params: {
  slug: string;
  session?: AuthenticatedBrowserSession | null;
  liveConnection: DbConnection;
}): Promise<Error | null> {
  if (!params.session) {
    return null;
  }

  let networkAgent: Awaited<ReturnType<typeof lookupMasumiNetworkAgent>>;
  try {
    networkAgent = await lookupMasumiNetworkAgent({
      slug: params.slug,
      session: params.session,
      liveConnection: params.liveConnection,
    });
  } catch (error) {
    // Masumi registry lookup is advisory here — network/auth failures must
    // not block sends. Surface via console so the failure isn't invisible.
    console.warn('Masumi inbox-agent chat-state lookup failed', {
      slug: params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!networkAgent) {
    return null;
  }
  if (isDeregisteringOrDeregisteredInboxAgentState(networkAgent.registrationState)) {
    return new DeregisteredInboxAgentError({
      slug: networkAgent.slug,
      state: networkAgent.registrationState,
    });
  }
  if (isFailedRegistrationInboxAgentState(networkAgent.registrationState)) {
    return new Error(
      `Agent \`${networkAgent.slug}\` has an invalid Masumi registration and cannot be used for chats.`
    );
  }
  return null;
}

export async function assertMasumiNetworkAgentCanReceiveChats(params: {
  slug: string;
  session?: AuthenticatedBrowserSession | null;
  liveConnection: DbConnection;
}): Promise<void> {
  const block = await getMasumiNetworkAgentChatBlock(params);
  if (block) {
    throw block;
  }
}

async function filterMasumiNetworkAgentsThatCanReceiveChats(params: {
  actors: ResolvedPublishedActor[];
  session?: AuthenticatedBrowserSession | null;
  liveConnection: DbConnection;
}): Promise<{
  matches: ResolvedPublishedActor[];
  firstBlockedError: Error | null;
}> {
  const matches: ResolvedPublishedActor[] = [];
  const blockedBySlug: Array<{ slug: string; error: Error }> = [];

  for (const actor of params.actors) {
    const block = await getMasumiNetworkAgentChatBlock({
      slug: actor.slug,
      session: params.session,
      liveConnection: params.liveConnection,
    });
    if (block) {
      blockedBySlug.push({ slug: actor.slug, error: block });
      continue;
    }
    matches.push(actor);
  }

  // Intentional: when an email resolves to several published actors and only
  // some are blocked (deregistered / failed registration), we pick from the
  // still-available ones rather than failing the whole send. Surface the
  // dropped peers via console.warn so the choice isn't invisible in DevTools.
  if (matches.length > 0 && blockedBySlug.length > 0) {
    for (const { slug, error } of blockedBySlug) {
      console.warn('Excluding blocked published inbox actor from candidate list', {
        slug,
        reason: error.message,
      });
    }
  }

  return { matches, firstBlockedError: blockedBySlug[0]?.error ?? null };
}

export async function resolvePublishedActorsForIdentifier(params: {
  identifier: string;
  liveConnection: DbConnection;
  session?: AuthenticatedBrowserSession | null;
}): Promise<{
  matches: ResolvedPublishedActor[];
  selected: ResolvedPublishedActor;
}> {
  const identifier = params.identifier.trim();
  if (!identifier) {
    throw new Error('Enter a slug or email.');
  }

  const looksLikeEmail = identifier.includes('@');

  if (looksLikeEmail) {
    const exactEmailMatches = (
      await params.liveConnection.procedures.lookupPublishedAgentsByEmail({
        email: identifier,
      })
    )
      .map((actor: PublishedActorLookupLike) => {
        return toResolvedActor(
          actor,
          null,
          identifier
        );
      });

    if (exactEmailMatches.length > 0) {
      const available = await filterMasumiNetworkAgentsThatCanReceiveChats({
        actors: exactEmailMatches,
        session: params.session,
        liveConnection: params.liveConnection,
      });
      if (available.matches.length === 0 && available.firstBlockedError) {
        throw available.firstBlockedError;
      }
      if (available.matches.length === 0) {
        throw new Error('No available published inbox actor found for that email.');
      }
      const selected = selectResolvedPublishedActor(available.matches, identifier);
      return {
        matches: available.matches,
        selected,
      };
    }
  }

  const requestedSlug = looksLikeEmail ? '' : normalizeInboxSlug(identifier);
  if (requestedSlug) {
    const exactSlugMatch = (
      await params.liveConnection.procedures.lookupPublishedAgentBySlug({
        slug: requestedSlug,
      })
    )[0];
    if (exactSlugMatch) {
      const selected = toResolvedActor(exactSlugMatch);
      await assertMasumiNetworkAgentCanReceiveChats({
        slug: selected.slug,
        session: params.session,
        liveConnection: params.liveConnection,
      });
      return {
        matches: [selected],
        selected,
      };
    }
  }

  throw new Error('No published inbox actor found for that slug or email.');
}
