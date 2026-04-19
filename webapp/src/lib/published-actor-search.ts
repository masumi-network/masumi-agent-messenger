import type { AuthenticatedBrowserSession } from './auth-session';
import {
  findMasumiInboxAgents,
  listMasumiInboxAgents,
} from './inbox-agent-registration';
import type { DbConnection } from '@/module_bindings';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { MasumiInboxAgentEntry } from '../../../shared/inbox-agent-registration';
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

export async function discoverMasumiNetworkAgents(params: {
  identifier?: string;
  session: AuthenticatedBrowserSession;
  take?: number;
  page?: number;
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
    remoteMatches.map(async entry => ({
      slug: normalizeInboxSlug(entry.agentSlug) ?? entry.agentSlug.trim(),
      displayName: entry.name ?? null,
      description: entry.description ?? null,
      agentIdentifier: entry.agentIdentifier ?? null,
      linkedEmail: extractEmailFromResult(entry),
    }))
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

export async function resolvePublishedActorsForIdentifier(params: {
  identifier: string;
  liveConnection: DbConnection;
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
      return {
        matches: exactEmailMatches,
        selected: selectResolvedPublishedActor(exactEmailMatches, identifier),
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
      return {
        matches: [selected],
        selected,
      };
    }
  }

  throw new Error('No published inbox actor found for that slug or email.');
}
