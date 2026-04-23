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
  isAnyDeregistrationInboxAgentState,
  isMissingRequiredScopeMessage,
  isOwnedSaasRegistrationBlockingFreshCreate,
  mergeMasumiRegistrationMetadataFromEntry,
  type MasumiInboxAgentNetwork,
  MASUMI_INBOX_AGENT_REQUIRED_CREDITS,
  type MasumiActorRegistrationMetadata,
  type MasumiRegistryInboxAgentStatus,
  normalizeMasumiDiscoveryPage,
  normalizeMasumiDiscoveryTake,
  parseMasumiPayInboxAgentCollection,
  parseMasumiRegistryInboxAgentCollection,
  parseMasumiPayInboxAgentEntry,
  pickOwnedSaasExactInboxAgentMatch,
  pickNewestExactInboxAgentMatch,
  registrationResultFromMetadata,
  serializeMasumiRegistrationMetadata,
  type MasumiInboxAgentEntry,
  type SerializedMasumiActorRegistrationMetadata,
  type SerializedMasumiInboxAgentSearchResponse,
  type SerializedMasumiActorRegistrationSubject,
  type SerializedMasumiRegistrationResponse,
} from '../../../shared/inbox-agent-registration';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { AuthenticatedRequestBrowserSession } from './oidc-auth.server';
import { fetchMasumiApi } from './masumi-api';
import { readActorRegistrationMetadata } from './inbox-agent-registration';
import { resolveOwnedActorBySlugForSession } from './spacetimedb-server';

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
  includeDeregistered?: boolean;
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
    agents = params.includeDeregistered
      ? parsed.agents
      : parsed.agents.filter(entry => isNonDeregisteredInboxAgentState(entry.state));
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
  includeDeregistered?: boolean;
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
    filterStatuses: ['Pending', 'Verified', 'Deregistered', 'Invalid'],
    includeDeregistered: true,
  });
  const exactMatch = pickNewestExactInboxAgentMatch({
    entries: result.agents,
    slug,
    includeDeregistered: true,
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
  includeDeregistered?: boolean;
}): Promise<MasumiInboxAgentEntry | null> {
  const includeDeregistered = params.includeDeregistered ?? false;
  const result = await fetchMasumiInboxAgentRegistrationsForSession({
    session: params.session,
    agentSlug: params.slug,
    take: 20,
    page: 1,
    filterStatuses: includeDeregistered
      ? ['Pending', 'Verified', 'Deregistered', 'Invalid']
      : ['Pending', 'Verified'],
    includeDeregistered,
  });
  return pickNewestExactInboxAgentMatch({
    entries: result.agents,
    slug: params.slug,
    includeDeregistered,
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

async function discoverOwnedPayInboxAgentBySlug(params: {
  session: AuthenticatedRequestBrowserSession;
  slug: string;
  filterStatus?: 'Registered' | 'Pending' | 'Deregistered' | 'Failed';
}): Promise<MasumiInboxAgentEntry | null> {
  const normalizedSlug = normalizeInboxSlug(params.slug);
  if (!normalizedSlug) {
    return null;
  }

  let cursor: string | null = null;

  do {
    const url = buildMasumiPayApiUrl(params.session.user.issuer, 'inbox-agents');
    url.searchParams.set('network', getMasumiInboxAgentNetwork());
    url.searchParams.set('take', '20');
    url.searchParams.set('search', normalizedSlug);
    if (params.filterStatus) {
      url.searchParams.set('filterStatus', params.filterStatus);
    }
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetchMasumiApi(params.session, url);
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? `Unable to list inbox agents (${response.status})`);
    }

    const parsed = parseMasumiPayInboxAgentCollection(await response.json());
    const exact = params.filterStatus
      ? pickOwnedSaasExactInboxAgentMatch({
          entries: parsed.agents,
          slug: normalizedSlug,
        })
      : pickNewestExactInboxAgentMatch({
          entries: parsed.agents,
          slug: normalizedSlug,
          includeDeregistered: true,
        });
    if (exact) {
      return exact;
    }

    cursor = parsed.nextCursor;
  } while (cursor);

  return null;
}

async function discoverOwnedBlockingPayInboxAgentBySlug(params: {
  session: AuthenticatedRequestBrowserSession;
  slug: string;
}): Promise<MasumiInboxAgentEntry | null> {
  const registered = await discoverOwnedPayInboxAgentBySlug({
    session: params.session,
    slug: params.slug,
    filterStatus: 'Registered',
  });
  if (registered) {
    return registered;
  }

  return discoverOwnedPayInboxAgentBySlug({
    session: params.session,
    slug: params.slug,
    filterStatus: 'Pending',
  });
}

function hasTrustedLocalConfirmedRegistration(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): boolean {
  return Boolean(
    metadata?.masumiInboxAgentId?.trim() &&
      metadata.masumiRegistrationState === 'RegistrationConfirmed'
  );
}

export function masumiRegistrationClientErrorToHttpStatus(
  error: unknown
): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message === 'Inbox-agent request payload is invalid') {
    return 400;
  }
  if (message.startsWith('No owned inbox actor found for slug `')) {
    return 404;
  }
  if (message.includes(' cannot be deregistered while its state is ')) {
    return 409;
  }
  return null;
}

export function createMasumiRegistrationOperationalFailureResponse(params: {
  session: AuthenticatedRequestBrowserSession;
  error: unknown;
  currentRegistration?: SerializedMasumiActorRegistrationMetadata | null;
}): SerializedMasumiRegistrationResponse {
  const message =
    params.error instanceof Error
      ? params.error.message
      : 'Unable to process inbox-agent registration';
  const metadata = deserializeMasumiRegistrationMetadata(
    params.currentRegistration
  );
  const current = metadata
    ? registrationResultFromMetadata(metadata)
    : createEmptyMasumiRegistrationResult();

  return {
    registration: {
      ...current,
      status: isMissingRequiredScopeMessage(message)
        ? 'scope_missing'
        : 'service_unavailable',
      error: isMissingRequiredScopeMessage(message)
        ? toScopeMessage(message, params.session)
        : message,
    },
    metadata: serializeMasumiRegistrationMetadata(metadata),
  };
}

export async function resolveTrustedOwnedRegistrationSubjectForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<SerializedMasumiActorRegistrationSubject> {
  const actor = await resolveOwnedActorBySlugForSession({
    session: params.session,
    slug: params.subject.slug,
  });

  if (!actor) {
    throw new Error(`No owned inbox actor found for slug \`${params.subject.slug}\`.`);
  }

  return {
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    registration: serializeMasumiRegistrationMetadata(readActorRegistrationMetadata(actor)),
  };
}

function isDeregisterableRegistrationMetadata(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): metadata is MasumiActorRegistrationMetadata & { masumiInboxAgentId: string } {
  return Boolean(
    metadata?.masumiInboxAgentId?.trim() &&
      metadata.masumiRegistrationState === 'RegistrationConfirmed'
  );
}

async function resolveDeregisterableRegistrationMetadata(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<MasumiActorRegistrationMetadata | null> {
  const currentMetadata = deserializeMasumiRegistrationMetadata(params.subject.registration);
  // Always resolve from the authenticated user's Pay inbox-agent list. The
  // public registry id is not guaranteed to be the Pay inboxAgentId accepted by
  // /deregister. If the owned list is empty, fall back to the trusted actor
  // metadata that the route resolved from SpacetimeDB for this owned slug.
  const discovered = await discoverOwnedPayInboxAgentBySlug({
    session: params.session,
    slug: params.subject.slug,
  });
  if (discovered) {
    return mergeMasumiRegistrationMetadataFromEntry({
      entry: discovered,
      current: currentMetadata,
      preserveCurrentAgentIdentifier: true,
    });
  }
  return isDeregisterableRegistrationMetadata(currentMetadata) ? currentMetadata : null;
}

async function deregisterInboxAgent(params: {
  session: AuthenticatedRequestBrowserSession;
  inboxAgentId: string;
}): Promise<MasumiInboxAgentEntry> {
  const url = buildMasumiPayApiUrl(
    params.session.user.issuer,
    `inbox-agents/${encodeURIComponent(params.inboxAgentId)}/deregister`
  );
  url.searchParams.set('network', getMasumiInboxAgentNetwork());

  const response = await fetchMasumiApi(params.session, url, {
    method: 'POST',
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(body.error ?? `Unable to deregister inbox agent (${response.status})`);
  }

  return parseMasumiPayInboxAgentEntry(await response.json());
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
      includeDeregistered:
        Boolean(metadata?.masumiInboxAgentId) ||
        isAnyDeregistrationInboxAgentState(metadata?.masumiRegistrationState),
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

    const nextMetadata = mergeMasumiRegistrationMetadataFromEntry({
      entry: discovered,
      current: metadata,
      preserveCurrentAgentIdentifier: true,
    });
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

export async function deregisterMasumiInboxAgentForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<SerializedMasumiRegistrationResponse> {
  try {
    const metadata = await resolveDeregisterableRegistrationMetadata({
      session: params.session,
      subject: params.subject,
    });

    if (!isDeregisterableRegistrationMetadata(metadata)) {
      const state = metadata?.masumiRegistrationState ?? 'not registered';
      throw new Error(
        `Inbox agent ${params.subject.slug} cannot be deregistered while its state is ${state}.`
      );
    }

    const deregistered = await deregisterInboxAgent({
      session: params.session,
      inboxAgentId: metadata.masumiInboxAgentId,
    });
    const nextMetadata = mergeMasumiRegistrationMetadataFromEntry({
      entry: deregistered,
      current: metadata,
      preserveCurrentAgentIdentifier: true,
    });
    return {
      registration: {
        ...registrationResultFromMetadata(nextMetadata),
        attempted: true,
        error: null,
      },
      metadata: serializeMasumiRegistrationMetadata(nextMetadata),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to deregister inbox agent';
    const wrapped = new Error(
      isMissingRequiredScopeMessage(message) ? toScopeMessage(message, params.session) : message
    );
    (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

export async function registerMasumiInboxAgentForSession(params: {
  session: AuthenticatedRequestBrowserSession;
  subject: SerializedMasumiActorRegistrationSubject;
}): Promise<SerializedMasumiRegistrationResponse> {
  const metadata = deserializeMasumiRegistrationMetadata(params.subject.registration);
  const result = registrationResultFromMetadata(metadata);
  let discovered: MasumiInboxAgentEntry | null;

  try {
    discovered = await discoverOwnedBlockingPayInboxAgentBySlug({
      session: params.session,
      slug: params.subject.slug,
    });

    if (
      discovered &&
      isOwnedSaasRegistrationBlockingFreshCreate(discovered.state)
    ) {
      const nextMetadata = mergeMasumiRegistrationMetadataFromEntry({
        entry: discovered,
        current: metadata,
        preserveCurrentAgentIdentifier: true,
      });
      return {
        registration: registrationResultFromMetadata(nextMetadata),
        metadata: serializeMasumiRegistrationMetadata(nextMetadata),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to lookup inbox agent';
    return {
      registration: {
        ...result,
        status: isMissingRequiredScopeMessage(message) ? 'scope_missing' : 'service_unavailable',
        error: isMissingRequiredScopeMessage(message)
          ? toScopeMessage(message, params.session)
          : message,
      },
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }

  if (!discovered && hasTrustedLocalConfirmedRegistration(metadata)) {
    return {
      registration: registrationResultFromMetadata(metadata),
      metadata: serializeMasumiRegistrationMetadata(metadata),
    };
  }

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

    const nextMetadata = mergeMasumiRegistrationMetadataFromEntry({
      entry: created.entry,
      current: metadata,
      preserveCurrentAgentIdentifier: true,
    });
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
