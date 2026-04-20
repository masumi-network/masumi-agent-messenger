import {
  type MasumiApiCreditsData,
  buildMasumiApiUrl,
  buildMasumiPayInboxAgentCreateRequest,
  buildMasumiRegistryInboxAgentBrowseRequest,
  buildMasumiRegistryInboxAgentSearchRequest,
  buildMasumiPayApiUrl,
  buildMasumiRegistryApiUrl,
  createEmptyMasumiRegistrationResult,
  deserializeMasumiRegistrationMetadata,
  getMasumiInboxAgentNetwork as getGeneratedMasumiInboxAgentNetwork,
  isNonDeregisteredInboxAgentState,
  isPendingMasumiInboxAgentState,
  isMissingRequiredScopeMessage,
  type MasumiInboxAgentNetwork,
  MASUMI_INBOX_AGENT_REQUIRED_CREDITS,
  type MasumiRegistryInboxAgentStatus,
  normalizeMasumiDiscoveryPage,
  normalizeMasumiDiscoveryTake,
  parseMasumiRegistryInboxAgentCollection,
  parseMasumiPayInboxAgentEntry,
  pickNewestExactInboxAgentMatch,
  registrationMetadataFromEntry,
  registrationResultFromMetadata,
  serializeMasumiRegistrationMetadata,
  type MasumiInboxAgentEntry,
  type SerializedMasumiInboxAgentSearchResponse,
  type SerializedMasumiActorRegistrationSubject,
  type SerializedMasumiRegistrationResponse,
} from '../../../shared/inbox-agent-registration';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { AuthenticatedRequestBrowserSession } from './oidc-auth.server';
import { fetchMasumiApi } from './masumi-api';

function getMasumiInboxAgentNetwork(): MasumiInboxAgentNetwork {
  const raw = process.env.MASUMI_NETWORK?.trim();
  if (!raw) return getGeneratedMasumiInboxAgentNetwork();
  const cap = (raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()) as MasumiInboxAgentNetwork;
  if (cap === 'Preprod' || cap === 'Mainnet') return cap;
  return getGeneratedMasumiInboxAgentNetwork();
}

type ErrorBody = {
  error?: string;
  creditsRemaining?: number;
};

function parseCreditsPayload(value: unknown): { creditsRemaining: number } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'creditsRemaining' in value.data &&
    typeof value.data.creditsRemaining === 'number'
  ) {
    return value.data as MasumiApiCreditsData;
  }

  throw new Error('Masumi credits response is invalid');
}

function describeGrantedScopes(session: AuthenticatedRequestBrowserSession): string {
  const scopes = session.grantedScopes?.filter(Boolean) ?? [];
  return scopes.length > 0 ? scopes.join(', ') : 'none';
}

function toScopeMessage(
  error: string,
  session: AuthenticatedRequestBrowserSession
): string {
  return `Missing Masumi scope or access token. masumi-agent-messenger already requests the full supported permission catalog during OIDC sign-in. ${error} Current granted scopes: ${describeGrantedScopes(session)}. If it still fails, update the user OIDC grants for this client in Masumi SaaS.`;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

export async function loadMasumiCreditsForSession(
  session: AuthenticatedRequestBrowserSession
): Promise<number> {
  const response = await fetchMasumiApi(
    session,
    buildMasumiApiUrl(session.user.issuer, 'credits')
  );

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(body.error ?? `Unable to load credits (${response.status})`);
  }

  const payload = parseCreditsPayload(await response.json());
  return payload.creditsRemaining;
}

async function fetchMasumiInboxAgentRegistrationsForSessionRaw(params: {
  session: AuthenticatedRequestBrowserSession;
  take?: number;
  page?: number;
  filterStatuses?: MasumiRegistryInboxAgentStatus[];
  agentSlug?: string;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const take = normalizeMasumiDiscoveryTake(params.take);
  const page = normalizeMasumiDiscoveryPage(params.page);
  const url = buildMasumiRegistryApiUrl(
    params.session.user.issuer,
    'inbox-agent-registration'
  );
  url.searchParams.set('network', getMasumiInboxAgentNetwork());
  let cursorId: string | undefined;
  let agents: MasumiInboxAgentEntry[] = [];
  let hasNextPage = false;

  for (let currentPage = 1; currentPage <= page; currentPage += 1) {
    const response = await fetchMasumiApi(params.session, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildMasumiRegistryInboxAgentBrowseRequest({
          limit: take,
          cursorId,
          agentSlug: params.agentSlug,
          statuses: params.filterStatuses,
        })
      ),
    });
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? `Unable to search inbox agents (${response.status})`);
    }

    const parsed = parseMasumiRegistryInboxAgentCollection(await response.json());
    agents = parsed.agents.filter(entry => isNonDeregisteredInboxAgentState(entry.state));
    hasNextPage = agents.length >= take && parsed.nextCursor !== null;

    if (currentPage === page) {
      break;
    }

    if (!hasNextPage) {
      agents = [];
      break;
    }

    cursorId = parsed.nextCursor ?? undefined;
  }

  return {
    agents,
    page,
    take,
    hasNextPage,
  };
}

async function refreshPendingMasumiInboxAgentEntriesForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  entries: MasumiInboxAgentEntry[];
}): Promise<MasumiInboxAgentEntry[]> {
  return Promise.all(
    params.entries.map(async entry => {
      if (!isPendingMasumiInboxAgentState(entry.state)) {
        return entry;
      }

      const slug = normalizeInboxSlug(entry.agentSlug) ?? entry.agentSlug.trim();
      if (!slug) {
        return entry;
      }

      try {
        const refreshed = await fetchMasumiInboxAgentRegistrationsForSessionRaw({
          session: params.session,
          agentSlug: slug,
          take: 20,
          page: 1,
          filterStatuses: ['Pending', 'Verified'],
        });
        return (
          pickNewestExactInboxAgentMatch({
            entries: refreshed.agents,
            slug,
          }) ?? entry
        );
      } catch {
        return entry;
      }
    })
  );
}

async function fetchMasumiInboxAgentRegistrationsForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  take?: number;
  page?: number;
  filterStatuses?: MasumiRegistryInboxAgentStatus[];
  agentSlug?: string;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const result = await fetchMasumiInboxAgentRegistrationsForSessionRaw(params);
  return {
    ...result,
    agents: await refreshPendingMasumiInboxAgentEntriesForSession({
      session: params.session,
      entries: result.agents,
    }),
  };
}

async function searchMasumiInboxAgentRegistrationsForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  search: string;
  take?: number;
  page?: number;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const search = params.search.trim();
  const take = normalizeMasumiDiscoveryTake(params.take);
  const page = normalizeMasumiDiscoveryPage(params.page);

  if (!search) {
    return {
      agents: [],
      page,
      take,
      hasNextPage: false,
    };
  }

  const url = buildMasumiRegistryApiUrl(
    params.session.user.issuer,
    'inbox-agent-registration-search'
  );
  url.searchParams.set('network', getMasumiInboxAgentNetwork());
  let cursorId: string | undefined;
  let agents: MasumiInboxAgentEntry[] = [];
  let hasNextPage = false;

  for (let currentPage = 1; currentPage <= page; currentPage += 1) {
    const response = await fetchMasumiApi(params.session, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildMasumiRegistryInboxAgentSearchRequest({
          query: search,
          limit: take,
          cursorId,
          statuses: ['Verified'],
        })
      ),
    });
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? `Unable to search inbox agents (${response.status})`);
    }

    const parsed = parseMasumiRegistryInboxAgentCollection(await response.json());
    agents = parsed.agents.filter(entry => isNonDeregisteredInboxAgentState(entry.state));
    hasNextPage = agents.length >= take && parsed.nextCursor !== null;

    if (currentPage === page) {
      break;
    }

    if (!hasNextPage) {
      agents = [];
      break;
    }

    cursorId = parsed.nextCursor ?? undefined;
  }

  return {
    agents: await refreshPendingMasumiInboxAgentEntriesForSession({
      session: params.session,
      entries: agents,
    }),
    page,
    take,
    hasNextPage,
  };
}

export function prioritizeVerifiedMasumiInboxAgents(params: {
  entries: MasumiInboxAgentEntry[];
  verifiedAgentIdentifiers: Set<string>;
}): MasumiInboxAgentEntry[] {
  return params.entries.filter(
    entry =>
      entry.agentIdentifier !== null &&
      params.verifiedAgentIdentifiers.has(entry.agentIdentifier)
  );
}

export async function findMasumiInboxAgentsForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  search: string;
  take?: number;
  page?: number;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  return searchMasumiInboxAgentRegistrationsForSession(params);
}

export async function listMasumiInboxAgentsForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  take?: number;
  page?: number;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  return fetchMasumiInboxAgentRegistrationsForSession({
    ...params,
    filterStatuses: ['Pending', 'Verified'],
  });
}

export async function lookupMasumiInboxAgentForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  slug: string;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const slug = normalizeInboxSlug(params.slug);
  if (!slug) {
    return {
      agents: [],
      page: 1,
      take: normalizeMasumiDiscoveryTake(undefined),
      hasNextPage: false,
    };
  }

  const result = await fetchMasumiInboxAgentRegistrationsForSession({
    session: params.session,
    agentSlug: slug,
    take: 20,
    page: 1,
    filterStatuses: ['Pending', 'Verified'],
  });
  const exactMatch = pickNewestExactInboxAgentMatch({
    entries: result.agents,
    slug,
  });

  return {
    agents: exactMatch ? [exactMatch] : [],
    page: 1,
    take: result.take,
    hasNextPage: false,
  };
}

async function discoverInboxAgentBySlug(params: {
  session: AuthenticatedRequestBrowserSession;
  slug: string;
}): Promise<MasumiInboxAgentEntry | null> {
  const result = await fetchMasumiInboxAgentRegistrationsForSession({
    session: params.session,
    agentSlug: params.slug,
    take: 20,
    page: 1,
    filterStatuses: ['Pending', 'Verified'],
  });
  return pickNewestExactInboxAgentMatch({
    entries: result.agents,
    slug: params.slug,
  });
}

async function createInboxAgent(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<
  | { kind: 'success'; entry: MasumiInboxAgentEntry }
  | { kind: 'insufficient_credits'; creditsRemaining: number | null; error: string }
> {
  const url = buildMasumiPayApiUrl(params.session.user.issuer, 'inbox-agents');
  url.searchParams.set('network', getMasumiInboxAgentNetwork());

  const response = await fetchMasumiApi(params.session, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      buildMasumiPayInboxAgentCreateRequest({
        name: params.subject.displayName?.trim() || params.subject.slug,
        agentSlug: params.subject.slug,
      })
    ),
  });

  if (response.status === 402) {
    const body = await readErrorBody(response);
    return {
      kind: 'insufficient_credits',
      creditsRemaining:
        typeof body.creditsRemaining === 'number' ? body.creditsRemaining : null,
      error:
        body.error ?? 'Not enough Masumi credits to register an inbox agent right now.',
    };
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(body.error ?? `Unable to register inbox agent (${response.status})`);
  }

  const payload = await response.json();
  return {
    kind: 'success',
    entry: parseMasumiPayInboxAgentEntry(payload),
  };
}

export async function syncMasumiInboxAgentRegistrationForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<SerializedMasumiRegistrationResponse> {
  const metadata = deserializeMasumiRegistrationMetadata(params.subject.registration);
  const result = registrationResultFromMetadata(metadata);

  try {
    const discovered = await discoverInboxAgentBySlug({
      session: params.session,
      slug: params.subject.slug,
    });

    if (!discovered) {
      return {
        registration: {
          ...(metadata ? result : createEmptyMasumiRegistrationResult()),
          skipped: !metadata,
        },
        metadata: serializeMasumiRegistrationMetadata(metadata),
      };
    }

    const nextMetadata = registrationMetadataFromEntry(discovered);
    return {
      registration: registrationResultFromMetadata(nextMetadata),
      metadata: serializeMasumiRegistrationMetadata(nextMetadata),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to discover inbox-agent registration';
    return {
      registration: {
        ...result,
        status: metadata
          ? result.status
          : isMissingRequiredScopeMessage(message)
            ? 'scope_missing'
            : 'service_unavailable',
        error: isMissingRequiredScopeMessage(message)
          ? toScopeMessage(message, params.session)
          : message,
      },
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }
}

export async function registerMasumiInboxAgentForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<SerializedMasumiRegistrationResponse> {
  const metadata = deserializeMasumiRegistrationMetadata(params.subject.registration);
  const result = registrationResultFromMetadata(metadata);

  let creditsRemaining: number | null;
  try {
    creditsRemaining = await loadMasumiCreditsForSession(params.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load credits';
    return {
      registration: {
        ...result,
        status: metadata
          ? result.status
          : isMissingRequiredScopeMessage(message)
            ? 'scope_missing'
            : 'service_unavailable',
        error: isMissingRequiredScopeMessage(message)
          ? toScopeMessage(message, params.session)
          : message,
      },
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }

  if (creditsRemaining < MASUMI_INBOX_AGENT_REQUIRED_CREDITS) {
    return {
      registration: {
        ...result,
        creditsRemaining,
        status: 'insufficient_credits',
        error: 'Not enough Masumi credits to register an inbox agent right now.',
      },
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }

  try {
    const created = await createInboxAgent(params);

    if (created.kind === 'insufficient_credits') {
      return {
        registration: {
          ...result,
          attempted: true,
          creditsRemaining: created.creditsRemaining,
          status: 'insufficient_credits',
          error: created.error,
        },
        metadata: serializeMasumiRegistrationMetadata(metadata),
      };
    }

    const nextMetadata = registrationMetadataFromEntry(created.entry);
    const nextRegistration = registrationResultFromMetadata(nextMetadata);

    return {
      registration: {
        ...nextRegistration,
        attempted: true,
        creditsRemaining,
        error: null,
      },
      metadata: serializeMasumiRegistrationMetadata(nextMetadata),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to register inbox agent';
    return {
      registration: {
        ...result,
        attempted: true,
        creditsRemaining,
        status: isMissingRequiredScopeMessage(message) ? 'scope_missing' : 'failed',
        error: isMissingRequiredScopeMessage(message)
          ? toScopeMessage(message, params.session)
          : message,
      },
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }
}
