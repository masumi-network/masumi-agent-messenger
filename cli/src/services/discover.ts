import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { MasumiInboxAgentEntry } from '../../../shared/inbox-agent-registration';
import type {
  PublishedAgentLookupRow,
  PublishedPublicRouteRow,
} from '../../../webapp/src/module_bindings/types';
import { ensureAuthenticatedSession } from './auth';
import { resolvePreferredAgentSlug } from './agent-state';
import type { TaskReporter } from './command-runtime';
import { connectivityError, isCliError, userError } from './errors';
import {
  findMasumiInboxAgents,
  listMasumiInboxAgents,
  lookupMasumiInboxAgentBySlug,
  searchMasumiInboxAgents,
} from './masumi-inbox-agent';
import {
  connectAuthenticated,
  disconnectConnection,
} from './spacetimedb';

export type DiscoverSearchItem = {
  slug: string;
  displayName: string | null;
  description: string | null;
  publicIdentity: string | null;
  isDefault: boolean | null;
  agentIdentifier: string | null;
  inboxPublished: boolean | null;
};

export type DiscoverSearchResult = {
  profile: string;
  agentSlug: string | null;
  query: string | null;
  mode: 'browse' | 'search';
  page: number;
  take: number;
  hasNextPage: boolean;
  total: number;
  results: DiscoverSearchItem[];
};

export type DiscoverShowResult = {
  profile: string;
  agentSlug: string | null;
  identifier: string;
  detailScope: 'saas_only' | 'slug_enriched';
  matchedActors: DiscoverSearchItem[];
  selected: DiscoverSearchItem & {
    encryptionKeyVersion: string | null;
    signingKeyVersion: string | null;
  };
  publicRoute: null | {
    agentIdentifier: string | null;
    linkedEmail: string | null;
    description: string | null;
    encryptionKeyVersion: string;
    signingKeyVersion: string;
    allowAllContentTypes: boolean;
    allowAllHeaders: boolean;
    supportedContentTypes: string[];
    supportedHeaders: Array<{
      name: string;
      required: boolean;
      allowMultiple: boolean;
      sensitive: boolean;
      allowedPrefixes: string[];
    }>;
    contactPolicy: {
      mode: string;
      allowlistScope: string;
      allowlistKinds: string[];
      messagePreviewVisibleBeforeApproval: boolean;
    };
  };
};

function normalizeQuery(query: string | undefined): string | null {
  const trimmed = query?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSearchValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function squashSearchValue(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '');
}

function splitSearchTokens(query: string): string[] {
  return normalizeSearchValue(query)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function isSubsequenceMatch(needle: string, haystack: string): boolean {
  if (!needle) {
    return true;
  }

  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }

  return false;
}

function scoreSearchField(field: string, token: string, priority: number): number | null {
  if (!field) {
    return null;
  }

  if (field === token) {
    return priority * 100;
  }

  if (field.startsWith(token)) {
    return priority * 100 + 10 + field.length / 1000;
  }

  const substringIndex = field.indexOf(token);
  if (substringIndex >= 0) {
    return priority * 100 + 20 + substringIndex / 100 + field.length / 10000;
  }

  const squashedToken = squashSearchValue(token);
  const squashedField = squashSearchValue(field);
  if (squashedToken && isSubsequenceMatch(squashedToken, squashedField)) {
    return priority * 100 + 40 + squashedField.length / 1000;
  }

  return null;
}

function scoreDiscoverSearchItem(item: DiscoverSearchItem, query: string): number | null {
  const normalizedQuery = normalizeSearchValue(query);
  const tokens = splitSearchTokens(query);
  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const fields = [
    { value: normalizeSearchValue(item.slug), priority: 0 },
    { value: normalizeSearchValue(item.displayName), priority: 1 },
    { value: normalizeSearchValue(item.description), priority: 2 },
    { value: normalizeSearchValue(item.publicIdentity), priority: 3 },
    { value: normalizeSearchValue(item.agentIdentifier), priority: 4 },
  ];

  let total = 0;

  for (const token of tokens) {
    let best: number | null = null;

    for (const field of fields) {
      const score = scoreSearchField(field.value, token, field.priority);
      if (score !== null && (best === null || score < best)) {
        best = score;
      }
    }

    if (best === null) {
      return null;
    }

    total += best;
  }

  if (
    fields.some(field => {
      return (
        field.value.includes(normalizedQuery) ||
        isSubsequenceMatch(squashSearchValue(normalizedQuery), squashSearchValue(field.value))
      );
    })
  ) {
    total -= 5;
  }

  return total;
}

export function rankDiscoverSearchItems(
  items: DiscoverSearchItem[],
  query: string,
  limit = items.length
): DiscoverSearchItem[] {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return items.slice(0, limit);
  }

  const ranked = items
    .map(item => ({
      item,
      score: scoreDiscoverSearchItem(item, normalizedQuery),
    }))
    .filter((entry): entry is { item: DiscoverSearchItem; score: number } => entry.score !== null)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.item.slug.localeCompare(right.item.slug);
    })
    .map(entry => entry.item);

  return ranked.slice(0, limit);
}

function isValidEmailIdentifier(value: string): boolean {
  return value.includes('@') && !value.startsWith('@') && !value.endsWith('@');
}

function normalizeDiscoverIdentifier(value: string): {
  inputKind: 'slug' | 'email';
  normalizedIdentifier: string;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    throw userError('Agent slug or email is required.', {
      code: 'INVALID_AGENT_IDENTIFIER',
    });
  }

  if (trimmed.includes('@')) {
    const normalizedIdentifier = normalizeEmail(trimmed);
    if (!isValidEmailIdentifier(normalizedIdentifier)) {
      throw userError('Agent slug or email is invalid.', {
        code: 'INVALID_AGENT_IDENTIFIER',
      });
    }

    return {
      inputKind: 'email',
      normalizedIdentifier,
    };
  }

  const normalizedIdentifier = normalizeInboxSlug(trimmed);
  if (!normalizedIdentifier) {
    throw userError('Agent slug or email is invalid.', {
      code: 'INVALID_AGENT_IDENTIFIER',
    });
  }

  return {
    inputKind: 'slug',
    normalizedIdentifier,
  };
}

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

function toDiscoverSearchItem(params: {
  entry: MasumiInboxAgentEntry;
  actor?: PublishedAgentLookupRow | null;
}): DiscoverSearchItem {
  return {
    slug: normalizeInboxSlug(params.entry.agentSlug) ?? params.entry.agentSlug.trim(),
    displayName: params.actor?.displayName ?? params.entry.name ?? null,
    description: params.entry.description ?? null,
    publicIdentity: params.actor?.publicIdentity ?? null,
    isDefault: params.actor?.isDefault ?? null,
    agentIdentifier: params.actor?.agentIdentifier ?? params.entry.agentIdentifier ?? null,
    inboxPublished: params.actor ? true : null,
  };
}

async function loadDiscoverSearchItems(params: {
  host: string;
  databaseName: string;
  sessionToken: string;
  entries: MasumiInboxAgentEntry[];
}): Promise<DiscoverSearchItem[]> {
  if (params.entries.length === 0) {
    return [];
  }

  let conn: Awaited<ReturnType<typeof connectAuthenticated>>['conn'] | null = null;

  try {
    conn = (
      await connectAuthenticated({
        host: params.host,
        databaseName: params.databaseName,
        sessionToken: params.sessionToken,
      })
    ).conn;

    const actors = await Promise.all(
      params.entries.map(async entry => {
        const normalizedSlug = normalizeInboxSlug(entry.agentSlug) ?? entry.agentSlug.trim();
        return tryLookupPublishedActorBySlug(conn!, normalizedSlug);
      })
    );

    return params.entries.map((entry, index) =>
      toDiscoverSearchItem({
        entry,
        actor: actors[index] ?? null,
      })
    );
  } catch {
    return params.entries.map(entry => toDiscoverSearchItem({ entry }));
  } finally {
    if (conn) {
      disconnectConnection(conn);
    }
  }
}

async function tryLookupPublishedActorBySlug(
  conn: Awaited<ReturnType<typeof connectAuthenticated>>['conn'],
  slug: string
): Promise<PublishedAgentLookupRow | null> {
  return (await conn.procedures.lookupPublishedAgentBySlug({ slug }))[0] ?? null;
}

function toPublicRoute(route: PublishedPublicRouteRow | null): DiscoverShowResult['publicRoute'] {
  if (!route) {
    return null;
  }

  return {
    agentIdentifier: route.agentIdentifier ?? null,
    linkedEmail: route.linkedEmail ?? null,
    description: route.description ?? null,
    encryptionKeyVersion: route.encryptionKeyVersion,
    signingKeyVersion: route.signingKeyVersion,
    allowAllContentTypes: route.allowAllContentTypes,
    allowAllHeaders: route.allowAllHeaders,
    supportedContentTypes: [...route.supportedContentTypes],
    supportedHeaders: route.supportedHeaders.map(header => ({
      name: header.name,
      required: Boolean(header.required),
      allowMultiple: Boolean(header.allowMultiple),
      sensitive: Boolean(header.sensitive),
      allowedPrefixes: header.allowedPrefixes ? [...header.allowedPrefixes] : [],
    })),
    contactPolicy: {
      mode: route.contactPolicy.mode,
      allowlistScope: route.contactPolicy.allowlistScope,
      allowlistKinds: [...route.contactPolicy.allowlistKinds],
      messagePreviewVisibleBeforeApproval:
        route.contactPolicy.messagePreviewVisibleBeforeApproval,
    },
  };
}

export async function discoverAgents(params: {
  profileName: string;
  reporter: TaskReporter;
  query?: string;
  limit?: number;
  page?: number;
  actorSlug?: string | null;
  allowPending?: boolean;
}): Promise<DiscoverSearchResult> {
  const query = normalizeQuery(params.query);
  const agentSlug = await resolvePreferredAgentSlug(params.profileName, params.actorSlug);
  const { profile, session } = await ensureAuthenticatedSession(params);

  try {
    const pageResult = query
      ? await searchMasumiInboxAgents({
          issuer: profile.issuer,
          session,
          search: query,
          take: params.limit,
          page: params.page,
          allowPending: params.allowPending,
        })
      : await listMasumiInboxAgents({
          issuer: profile.issuer,
          session,
          take: params.limit,
          page: params.page,
          allowPending: params.allowPending,
        });
    const items = await loadDiscoverSearchItems({
      host: profile.spacetimeHost,
      databaseName: profile.spacetimeDbName,
      sessionToken: session.idToken,
      entries: dedupeMasumiAgentsBySlug(pageResult.agents),
    });
    const results = query
      ? rankDiscoverSearchItems(items, query, pageResult.take)
      : items.slice(0, pageResult.take);

    return {
      profile: profile.name,
      agentSlug: agentSlug ?? null,
      query,
      mode: query ? 'search' : 'browse',
      page: pageResult.page,
      take: pageResult.take,
      hasNextPage: pageResult.hasNextPage,
      total: results.length,
      results,
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to search Masumi agents.', {
      code: 'DISCOVER_SEARCH_FAILED',
      cause: error,
    });
  }
}

export async function showDiscoveredAgent(params: {
  profileName: string;
  reporter: TaskReporter;
  identifier: string;
  actorSlug?: string | null;
  allowPending?: boolean;
}): Promise<DiscoverShowResult> {
  const agentSlug = await resolvePreferredAgentSlug(params.profileName, params.actorSlug);
  const { inputKind, normalizedIdentifier } = normalizeDiscoverIdentifier(params.identifier);
  const { profile, session } = await ensureAuthenticatedSession(params);
  const exactSlugMatch =
    inputKind === 'slug'
      ? await lookupMasumiInboxAgentBySlug({
          issuer: profile.issuer,
          session,
          slug: normalizedIdentifier,
          allowPending: params.allowPending,
        })
      : null;
  const remoteMatches = exactSlugMatch
    ? [exactSlugMatch]
    : dedupeMasumiAgentsBySlug(
        await findMasumiInboxAgents({
          issuer: profile.issuer,
          session,
          search: normalizedIdentifier,
          take: 20,
          allowPending: params.allowPending,
        })
      );

  if (remoteMatches.length === 0) {
    throw userError(
      inputKind === 'email'
        ? `No registered Masumi agents found for email \`${normalizedIdentifier}\`.`
        : `No registered Masumi agents found for slug \`${normalizedIdentifier}\`.`,
      {
        code: 'ACTOR_NOT_FOUND',
      }
    );
  }

  const matchedActors = remoteMatches.map(entry => toDiscoverSearchItem({ entry }));
  const selectedRemoteMatch =
    (inputKind === 'slug'
      ? remoteMatches.find(entry => {
          return (
            (normalizeInboxSlug(entry.agentSlug) ?? entry.agentSlug.trim()) === normalizedIdentifier
          );
        }) ?? null
      : null) ??
    remoteMatches[0] ??
    null;

  if (!selectedRemoteMatch) {
    throw userError(
      inputKind === 'email'
        ? `No registered Masumi agents found for email \`${normalizedIdentifier}\`.`
        : `No registered Masumi agents found for slug \`${normalizedIdentifier}\`.`,
      {
        code: 'ACTOR_NOT_FOUND',
      }
    );
  }

  let conn: Awaited<ReturnType<typeof connectAuthenticated>>['conn'] | null = null;
  let selectedActor: PublishedAgentLookupRow | null = null;

  try {
    if (inputKind === 'slug') {
      conn = (
        await connectAuthenticated({
          host: profile.spacetimeHost,
          databaseName: profile.spacetimeDbName,
          sessionToken: session.idToken,
        })
      ).conn;
      selectedActor = await tryLookupPublishedActorBySlug(conn, normalizedIdentifier);
    }

    const selected = toDiscoverSearchItem({
      entry: selectedRemoteMatch,
      actor: selectedActor,
    });
    const route =
      conn && selectedActor
        ? (
            await conn.procedures.lookupPublishedPublicRouteBySlug({
              slug: selected.slug,
            })
          )[0] ?? null
        : null;

    return {
      profile: profile.name,
      agentSlug: agentSlug ?? null,
      identifier: params.identifier,
      detailScope: inputKind === 'slug' ? 'slug_enriched' : 'saas_only',
      matchedActors,
      selected: {
        ...selected,
        encryptionKeyVersion: selectedActor?.encryptionKeyVersion ?? null,
        signingKeyVersion: selectedActor?.signingKeyVersion ?? null,
      },
      publicRoute: toPublicRoute(route),
    };
  } catch (error) {
    if (isCliError(error)) {
      throw error;
    }
    throw connectivityError('Unable to load the public agent details.', {
      code: 'DISCOVER_SHOW_FAILED',
      cause: error,
    });
  } finally {
    if (conn) {
      disconnectConnection(conn);
    }
  }
}
