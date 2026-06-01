import {
  type DbConnection,
} from '../../../webapp/src/module_bindings';
import type { Agent } from '../../../webapp/src/module_bindings/types';
import {
  type MasumiApiCreditsData,
  buildMasumiPayInboxAgentCreateRequest,
  buildMasumiApiUrl,
  buildMasumiRegistryInboxAgentBrowseRequest,
  buildMasumiRegistryInboxAgentSearchRequest,
  buildMasumiPayApiUrl,
  buildMasumiRegistryApiUrl,
  createEmptyMasumiRegistrationResult,
  parseMasumiRegistryInboxAgentCollection,
  parseMasumiPayInboxAgentCollection,
  parseMasumiPayInboxAgentEntry,
  isMasumiInboxAgentState,
  isNonDeregisteredInboxAgentState,
  isPendingMasumiInboxAgentState,
  isAnyDeregistrationInboxAgentState,
  isMissingRequiredScopeMessage,
  isOwnedSaasRegistrationBlockingFreshCreate,
  getMasumiInboxAgentNetwork,
  type MasumiInboxAgentNetwork,
  MASUMI_INBOX_AGENT_REQUIRED_CREDITS,
  type MasumiRegistryInboxAgentStatus,
  normalizeMasumiDiscoveryPage,
  normalizeMasumiDiscoveryTake,
  type MasumiActorRegistrationMetadata,
  type MasumiInboxAgentEntry,
  type MasumiRegistrationResult,
  mergeMasumiRegistrationMetadataFromEntry,
  pickOwnedSaasExactInboxAgentMatch,
  pickNewestExactInboxAgentMatch,
  registrationResultFromMetadata,
  type SerializedMasumiInboxAgentSearchResponse,
} from '../../../shared/inbox-agent-registration';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import { getOrCreateStoredActorKeyPair } from './actor-keys';
import type { TaskReporter } from './command-runtime';
import type { ResolvedProfile } from './config-store';
import { userError } from './errors';
import type { StoredOidcSession } from './oidc';
import { createSecretStore, type SecretStore } from './secret-store';
import { readAccounts } from './spacetimedb';

export type RegistrationMode = 'auto' | 'prompt' | 'skip';

export type ConfirmRegistrationPrompt = (params: {
  actorSlug: string;
  displayName: string | null;
  creditsRemaining: number | null;
  network: MasumiInboxAgentNetwork;
}) => Promise<boolean>;

export type ConfirmLinkedEmailPrompt = (params: {
  actorSlug: string;
  displayName: string | null;
}) => Promise<boolean>;

export type ConfirmPublicDescriptionPrompt = (params: {
  actorSlug: string;
  displayName: string | null;
}) => Promise<string | null>;

export type PauseHandler = (message: string) => Promise<void>;

type SyncResult = {
  registration: MasumiRegistrationResult;
  metadata: MasumiActorRegistrationMetadata | null;
};

const MASUMI_FETCH_TIMEOUT_MS = 15_000;
const IMPORTED_AGENT_SYNC_TIMEOUT_MS = 10_000;

class MasumiNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MasumiNetworkError';
  }
}

function isNetworkLikeError(error: unknown): boolean {
  if (error instanceof MasumiNetworkError) return true;
  if (error instanceof TypeError) return true; // undici/fetch network failures
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

async function fetchWithNetworkErrorTag(
  url: URL | string,
  init?: RequestInit,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? MASUMI_FETCH_TIMEOUT_MS;
  const controller =
    init?.signal || timeoutMs <= 0 ? null : new AbortController();
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    return await fetch(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new MasumiNetworkError(
        `Masumi request timed out after ${Math.round(timeoutMs / 1000).toString()} seconds.`,
        { cause: error }
      );
    }
    throw new MasumiNetworkError(
      error instanceof Error ? error.message : 'Network request failed',
      { cause: error }
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type ErrorBody = {
  error?: string;
  creditsRemaining?: number;
  requiredCredits?: number;
};

export type OwnedSaasAgentImportStatus =
  | 'imported'
  | 'synced'
  | 'present'
  | 'missing'
  | 'skipped'
  | 'warning';

export type OwnedSaasAgentImportItem = {
  slug: string;
  status: OwnedSaasAgentImportStatus;
  message: string;
};

export type OwnedSaasAgentImportSummary = {
  checked: number;
  imported: number;
  synced: number;
  present: number;
  missing: number;
  skipped: number;
  warnings: string[];
  successes: string[];
  items: OwnedSaasAgentImportItem[];
};

const INBOX_AGENT_SLUG_CONFLICT_MESSAGE =
  'Inbox slug is already in use on this network';

function isInboxAgentSlugConflictMessage(message: string): boolean {
  return message === INBOX_AGENT_SLUG_CONFLICT_MESSAGE;
}

type PaginatedInboxAgentParams = {
  issuer: string;
  session: StoredOidcSession;
  search?: string;
  take?: number;
  page?: number;
  filterStatuses?: MasumiRegistryInboxAgentStatus[];
  agentSlug?: string;
  includeDeregistered?: boolean;
  reporter?: TaskReporter;
};

function discoveryStatuses(params: {
  allowPending?: boolean;
}): MasumiRegistryInboxAgentStatus[] {
  return params.allowPending ? ['Pending', 'Verified'] : ['Verified'];
}

function dedupeMasumiInboxAgents(entries: MasumiInboxAgentEntry[]): MasumiInboxAgentEntry[] {
  const bySlug = new Map<string, MasumiInboxAgentEntry>();
  const slugOrder: string[] = [];

  for (const entry of entries) {
    const normalizedSlug = normalizeInboxSlug(entry.agentSlug);
    if (!normalizedSlug) {
      continue;
    }

    const existing = bySlug.get(normalizedSlug);
    if (!existing) {
      slugOrder.push(normalizedSlug);
      bySlug.set(normalizedSlug, entry);
      continue;
    }

    bySlug.set(
      normalizedSlug,
      pickOwnedSaasExactInboxAgentMatch({
        entries: [existing, entry],
        slug: normalizedSlug,
      }) ?? entry
    );
  }

  return slugOrder
    .map(slug => bySlug.get(slug))
    .filter((entry): entry is MasumiInboxAgentEntry => Boolean(entry));
}

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

function readActorRegistrationMetadata(
  actor: Agent
): MasumiActorRegistrationMetadata | null {
  // The Rust schema persists a coarse 5-state Masumi enum (with `None` for
  // "never registered"); map it back to the granular 8-state shared model.
  function rowStateToGranular(state: typeof actor.masumiRegistrationState):
    | 'RegistrationRequested'
    | 'RegistrationConfirmed'
    | 'DeregistrationRequested'
    | 'DeregistrationConfirmed'
    | 'RegistrationFailed'
    | undefined {
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
    }
  }
  const granularState = rowStateToGranular(actor.masumiRegistrationState);
  const metadata: MasumiActorRegistrationMetadata = {
    masumiRegistrationNetwork: actor.masumiRegistrationNetwork ?? undefined,
    masumiInboxAgentId: actor.masumiInboxAgentId ?? undefined,
    masumiAgentIdentifier: actor.masumiAgentIdentifier ?? undefined,
    masumiRegistrationState:
      granularState && isMasumiInboxAgentState(granularState) ? granularState : undefined,
  };

  return Object.values(metadata).some(value => value !== undefined) ? metadata : null;
}

function granularToRowState(
  state: string | undefined
): { tag: 'PendingRegistration' | 'Registered' | 'PendingDeregistration' | 'Deregistered' | 'Failed' } | undefined {
  if (!state) return undefined;
  switch (state) {
    case 'RegistrationRequested':
    case 'RegistrationInitiated':
      return { tag: 'PendingRegistration' };
    case 'RegistrationConfirmed':
      return { tag: 'Registered' };
    case 'RegistrationFailed':
    case 'DeregistrationFailed':
      return { tag: 'Failed' };
    case 'DeregistrationRequested':
    case 'DeregistrationInitiated':
      return { tag: 'PendingDeregistration' };
    case 'DeregistrationConfirmed':
      return { tag: 'Deregistered' };
    default:
      return undefined;
  }
}

function describeGrantedScopes(session: StoredOidcSession): string {
  const scopes = session.grantedScopes?.filter(Boolean) ?? [];
  return scopes.length > 0 ? scopes.join(', ') : 'none';
}

function toScopeMessage(error: string, session: StoredOidcSession): string {
  return `Missing Masumi scope or access token. Masumi Inbox already requests the full supported permission catalog during OIDC sign-in. ${error} Current granted scopes: ${describeGrantedScopes(session)}. If it still fails, update the user OIDC grants for this client in Masumi SaaS.`;
}

function toInsufficientCreditsMessage(params: {
  actorSlug: string;
  error?: string | null;
}): string {
  const detail = params.error?.trim();
  return `${detail || 'Not enough Masumi credits to register an inbox agent right now.'} Top up Masumi credits, then run \`masumi-agent-messenger agent network sync ${params.actorSlug}\` to register after top-up.`;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

function hasMasumiAccessToken(session: StoredOidcSession): session is StoredOidcSession & {
  accessToken: string;
} {
  return Boolean(session.accessToken?.trim());
}

function buildHeaders(accessToken: string): Headers {
  return new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });
}

function createEmptyOwnedSaasAgentImportSummary(): OwnedSaasAgentImportSummary {
  return {
    checked: 0,
    imported: 0,
    synced: 0,
    present: 0,
    missing: 0,
    skipped: 0,
    warnings: [],
    successes: [],
    items: [],
  };
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return String(error);
}

function pushImportItem(
  summary: OwnedSaasAgentImportSummary,
  item: OwnedSaasAgentImportItem
): void {
  summary.items.push(item);
  switch (item.status) {
    case 'imported':
      summary.imported += 1;
      summary.successes.push(item.message);
      break;
    case 'synced':
      summary.synced += 1;
      summary.successes.push(item.message);
      break;
    case 'present':
      summary.present += 1;
      break;
    case 'missing':
      summary.missing += 1;
      summary.warnings.push(item.message);
      break;
    case 'skipped':
      summary.skipped += 1;
      break;
    case 'warning':
      summary.warnings.push(item.message);
      break;
  }
}

async function fetchCredits(params: {
  issuer: string;
  accessToken: string;
}): Promise<number> {
  const creditsUrl = buildMasumiApiUrl(params.issuer, 'credits');
  creditsUrl.searchParams.set('network', getMasumiInboxAgentNetwork());
  const response = await fetchWithNetworkErrorTag(creditsUrl, {
    headers: buildHeaders(params.accessToken),
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(body.error ?? `Unable to load credits (${response.status})`);
  }

  const payload = parseCreditsPayload(await response.json());
  return payload.creditsRemaining;
}

async function fetchMasumiInboxAgentRegistrationsRaw(
  params: PaginatedInboxAgentParams
): Promise<SerializedMasumiInboxAgentSearchResponse> {
  if (!hasMasumiAccessToken(params.session)) {
    throw new Error(toScopeMessage('Masumi access token missing.', params.session));
  }

  const take = normalizeMasumiDiscoveryTake(params.take);
  const page = normalizeMasumiDiscoveryPage(params.page);
  const url = buildMasumiRegistryApiUrl(params.issuer, 'inbox-agent-registration');
  url.searchParams.set('network', getMasumiInboxAgentNetwork());
  let cursorId: string | undefined;
  let agents: MasumiInboxAgentEntry[] = [];
  let hasNextPage = false;

  for (let currentPage = 1; currentPage <= page; currentPage += 1) {
    const response = await fetchWithNetworkErrorTag(url, {
      method: 'POST',
      headers: (() => {
        const headers = buildHeaders(params.session.accessToken);
        headers.set('Content-Type', 'application/json');
        return headers;
      })(),
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

async function refreshPendingMasumiInboxAgentEntries(params: {
  issuer: string;
  session: StoredOidcSession;
  entries: MasumiInboxAgentEntry[];
  reporter?: TaskReporter;
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
        const refreshed = await fetchMasumiInboxAgentRegistrationsRaw({
          issuer: params.issuer,
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
      } catch (error) {
        params.reporter?.verbose?.(
          `Failed to refresh pending Masumi inbox agent entry for ${slug}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return entry;
      }
    })
  );
}

async function fetchMasumiInboxAgentRegistrations(
  params: PaginatedInboxAgentParams
): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const result = await fetchMasumiInboxAgentRegistrationsRaw(params);
  return {
    ...result,
    agents: await refreshPendingMasumiInboxAgentEntries({
      issuer: params.issuer,
      session: params.session,
      entries: result.agents,
      reporter: params.reporter,
    }),
  };
}

async function findMasumiInboxAgentsByLinkedEmail(params: {
  issuer: string;
  session: StoredOidcSession;
  search: string;
  take: number;
  filterStatuses: MasumiRegistryInboxAgentStatus[];
}): Promise<MasumiInboxAgentEntry[]> {
  const email = normalizeEmail(params.search);
  const emailSlug = normalizeInboxSlug(params.search);
  if (!email.includes('@') && !emailSlug.includes('-')) {
    return [];
  }

  const matches: MasumiInboxAgentEntry[] = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && matches.length < params.take) {
    const result = await fetchMasumiInboxAgentRegistrations({
      issuer: params.issuer,
      session: params.session,
      take: 50,
      page,
      filterStatuses: params.filterStatuses,
    });

    for (const entry of result.agents) {
      const linkedEmail = entry.linkedEmail?.trim();
      if (!linkedEmail) {
        continue;
      }

      if (
        normalizeEmail(linkedEmail) === email ||
        normalizeInboxSlug(linkedEmail) === emailSlug
      ) {
        matches.push(entry);
      }
    }

    hasNextPage = result.hasNextPage;
    page += 1;
  }

  return matches;
}

async function augmentMasumiInboxAgentSearchResults(params: {
  issuer: string;
  session: StoredOidcSession;
  search: string;
  take: number;
  agents: MasumiInboxAgentEntry[];
  filterStatuses: MasumiRegistryInboxAgentStatus[];
}): Promise<MasumiInboxAgentEntry[]> {
  if (params.agents.length > 0) {
    return params.agents;
  }

  const normalizedSlug = normalizeInboxSlug(params.search);
  const exactSlugMatches = normalizedSlug
    ? (
        await fetchMasumiInboxAgentRegistrations({
          issuer: params.issuer,
          session: params.session,
          agentSlug: normalizedSlug,
          take: params.take,
          page: 1,
          filterStatuses: params.filterStatuses,
        })
      ).agents
    : [];

  if (exactSlugMatches.length > 0) {
    return dedupeMasumiInboxAgents([...exactSlugMatches, ...params.agents]).slice(
      0,
      params.take
    );
  }

  const linkedEmailMatches = await findMasumiInboxAgentsByLinkedEmail({
    issuer: params.issuer,
    session: params.session,
    search: params.search,
    take: params.take,
    filterStatuses: params.filterStatuses,
  });

  return dedupeMasumiInboxAgents([
    ...exactSlugMatches,
    ...linkedEmailMatches,
    ...params.agents,
  ]).slice(0, params.take);
}

export async function findMasumiInboxAgents(params: {
  issuer: string;
  session: StoredOidcSession;
  search: string;
  take?: number;
  allowPending?: boolean;
}): Promise<MasumiInboxAgentEntry[]> {
  const entries = await searchMasumiInboxAgents(params);
  return entries.agents;
}

export async function listMasumiInboxAgents(params: {
  issuer: string;
  session: StoredOidcSession;
  take?: number;
  page?: number;
  allowPending?: boolean;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  return fetchMasumiInboxAgentRegistrations({
    ...params,
    filterStatuses: discoveryStatuses(params),
  });
}

export async function lookupMasumiInboxAgentBySlug(params: {
  issuer: string;
  session: StoredOidcSession;
  slug: string;
  allowPending?: boolean;
}): Promise<MasumiInboxAgentEntry | null> {
  const normalizedSlug = normalizeInboxSlug(params.slug);
  if (!normalizedSlug) {
    return null;
  }

  const entries = await fetchMasumiInboxAgentRegistrations({
    issuer: params.issuer,
    session: params.session,
    agentSlug: normalizedSlug,
    take: 20,
    page: 1,
    filterStatuses: ['Pending', 'Verified', 'Deregistered', 'Invalid'],
    includeDeregistered: true,
  });
  return pickNewestExactInboxAgentMatch({
    entries: entries.agents,
    slug: normalizedSlug,
    includeDeregistered: true,
  });
}

export async function searchMasumiInboxAgents(params: {
  issuer: string;
  session: StoredOidcSession;
  search: string;
  take?: number;
  page?: number;
  allowPending?: boolean;
}): Promise<SerializedMasumiInboxAgentSearchResponse> {
  if (!hasMasumiAccessToken(params.session)) {
    throw new Error(toScopeMessage('Masumi access token missing.', params.session));
  }

  const search = params.search.trim();
  const take = normalizeMasumiDiscoveryTake(params.take);
  const page = normalizeMasumiDiscoveryPage(params.page);
  const filterStatuses = discoveryStatuses(params);

  if (!search) {
    return {
      agents: [],
      page,
      take,
      hasNextPage: false,
    };
  }

  const url = buildMasumiRegistryApiUrl(params.issuer, 'inbox-agent-registration-search');
  url.searchParams.set('network', getMasumiInboxAgentNetwork());
  let cursorId: string | undefined;
  let agents: MasumiInboxAgentEntry[] = [];
  let hasNextPage = false;

  for (let currentPage = 1; currentPage <= page; currentPage += 1) {
    const response = await fetchWithNetworkErrorTag(url, {
      method: 'POST',
      headers: (() => {
        const headers = buildHeaders(params.session.accessToken);
        headers.set('Content-Type', 'application/json');
        return headers;
      })(),
      body: JSON.stringify(
        buildMasumiRegistryInboxAgentSearchRequest({
          query: search,
          limit: take,
          cursorId,
          statuses: filterStatuses,
        })
      ),
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? `Unable to search inbox agents (${response.status})`);
    }

    const parsed = parseMasumiRegistryInboxAgentCollection(await response.json());
    agents = parsed.agents.filter(entry => isNonDeregisteredInboxAgentState(entry.state));
    if (currentPage === 1) {
      agents = await augmentMasumiInboxAgentSearchResults({
        issuer: params.issuer,
        session: params.session,
        search,
        take,
        agents,
        filterStatuses,
      });
    }
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

async function discoverInboxAgentBySlug(params: {
  issuer: string;
  session: StoredOidcSession;
  slug: string;
  includeDeregistered?: boolean;
}): Promise<MasumiInboxAgentEntry | null> {
  const includeDeregistered = params.includeDeregistered ?? false;
  const entries = await fetchMasumiInboxAgentRegistrations({
    issuer: params.issuer,
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
    entries: entries.agents,
    slug: params.slug,
    includeDeregistered,
  });
}

async function registerInboxAgent(params: {
  issuer: string;
  accessToken: string;
  slug: string;
  displayName: string | null;
  description: string | null;
}): Promise<
  | { kind: 'success'; entry: MasumiInboxAgentEntry }
  | { kind: 'insufficient_credits'; creditsRemaining: number | null; error: string }
> {
  const url = buildMasumiPayApiUrl(params.issuer, 'inbox-agents');
  url.searchParams.set('network', getMasumiInboxAgentNetwork());

  const response = await fetchWithNetworkErrorTag(url, {
    method: 'POST',
    headers: (() => {
      const headers = buildHeaders(params.accessToken);
      headers.set('Content-Type', 'application/json');
      return headers;
    })(),
    body: JSON.stringify(
      buildMasumiPayInboxAgentCreateRequest({
        name: params.displayName?.trim() || params.slug,
        description: params.description ?? undefined,
        agentSlug: params.slug,
      })
    ),
  });

  if (response.status === 402) {
    const body = await readErrorBody(response);
    return {
      kind: 'insufficient_credits',
      creditsRemaining:
        typeof body.creditsRemaining === 'number' ? body.creditsRemaining : null,
      error: body.error ?? 'Insufficient credits',
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
  issuer: string;
  accessToken: string;
  slug: string;
  filterStatus?: 'Registered' | 'Pending' | 'Deregistered' | 'Failed';
  fullScanOnMiss?: boolean;
}): Promise<MasumiInboxAgentEntry | null> {
  const normalizedSlug = normalizeInboxSlug(params.slug);
  if (!normalizedSlug) {
    return null;
  }

  const lookup = async (search: string | null): Promise<MasumiInboxAgentEntry | null> => {
    let cursor: string | null = null;

    do {
      const url = buildMasumiPayApiUrl(params.issuer, 'inbox-agents');
      url.searchParams.set('network', getMasumiInboxAgentNetwork());
      url.searchParams.set('take', '20');
      if (search) {
        url.searchParams.set('search', search);
      }
      if (params.filterStatus) {
        url.searchParams.set('filterStatus', params.filterStatus);
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      const response = await fetchWithNetworkErrorTag(url, {
        headers: buildHeaders(params.accessToken),
      });

      if (!response.ok) {
        const body = await readErrorBody(response);
        throw userError(body.error ?? `Unable to list inbox agents (${response.status})`, {
          code: 'INBOX_AGENT_LOOKUP_FAILED',
        });
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
  };

  const searched = await lookup(normalizedSlug);
  if (searched || !params.fullScanOnMiss) {
    return searched;
  }
  return await lookup(null);
}

async function discoverOwnedBlockingPayInboxAgentBySlug(params: {
  issuer: string;
  accessToken: string;
  slug: string;
}): Promise<MasumiInboxAgentEntry | null> {
  const registered = await discoverOwnedPayInboxAgentBySlug({
    issuer: params.issuer,
    accessToken: params.accessToken,
    slug: params.slug,
    filterStatus: 'Registered',
  });
  if (registered) {
    return registered;
  }

  return discoverOwnedPayInboxAgentBySlug({
    issuer: params.issuer,
    accessToken: params.accessToken,
    slug: params.slug,
    filterStatus: 'Pending',
  });
}

async function listOwnedPayInboxAgents(params: {
  issuer: string;
  accessToken: string;
  filterStatus?: 'Registered' | 'Pending' | 'Deregistered' | 'Failed';
}): Promise<MasumiInboxAgentEntry[]> {
  const entries: MasumiInboxAgentEntry[] = [];
  let cursor: string | null = null;

  do {
    const url = buildMasumiPayApiUrl(params.issuer, 'inbox-agents');
    url.searchParams.set('network', getMasumiInboxAgentNetwork());
    url.searchParams.set('take', '20');
    if (params.filterStatus) {
      url.searchParams.set('filterStatus', params.filterStatus);
    }
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetchWithNetworkErrorTag(url, {
      headers: buildHeaders(params.accessToken),
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? `Unable to list inbox agents (${response.status})`);
    }

    const parsed = parseMasumiPayInboxAgentCollection(await response.json());
    entries.push(...parsed.agents);
    cursor = parsed.nextCursor;
  } while (cursor);

  return dedupeMasumiInboxAgents(entries);
}

async function listImportableOwnedPayInboxAgents(params: {
  issuer: string;
  accessToken: string;
}): Promise<MasumiInboxAgentEntry[]> {
  const [registered, pending] = await Promise.all([
    listOwnedPayInboxAgents({
      ...params,
      filterStatus: 'Registered',
    }),
    listOwnedPayInboxAgents({
      ...params,
      filterStatus: 'Pending',
    }),
  ]);
  return dedupeMasumiInboxAgents([...registered, ...pending]);
}

function hasTrustedLocalConfirmedRegistration(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): boolean {
  return Boolean(
    metadata?.masumiInboxAgentId?.trim() &&
      metadata.masumiRegistrationState === 'RegistrationConfirmed'
  );
}

function isDeregisterableRegistrationMetadata(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): metadata is MasumiActorRegistrationMetadata & { masumiInboxAgentId: string } {
  return Boolean(
    metadata?.masumiInboxAgentId?.trim() &&
      metadata.masumiRegistrationState === 'RegistrationConfirmed'
  );
}

const INBOX_AGENT_DEREGISTER_TIMEOUT_MS = 15_000;

class DeregisterTimeoutError extends Error {
  constructor() {
    super('Deregister request timed out');
    this.name = 'DeregisterTimeoutError';
  }
}

async function requestInboxAgentDeregistration(params: {
  issuer: string;
  accessToken: string;
  inboxAgentId: string;
  timeoutMs?: number;
}): Promise<MasumiInboxAgentEntry> {
  const url = buildMasumiPayApiUrl(
    params.issuer,
    `inbox-agents/${encodeURIComponent(params.inboxAgentId)}/deregister`
  );
  url.searchParams.set('network', getMasumiInboxAgentNetwork());

  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? INBOX_AGENT_DEREGISTER_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchWithNetworkErrorTag(url, {
      method: 'POST',
      headers: buildHeaders(params.accessToken),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw userError(body.error ?? `Unable to deregister inbox agent (${response.status})`, {
        code: 'INBOX_AGENT_DEREGISTER_REJECTED',
      });
    }

    const payload = await response.json();
    return parseMasumiPayInboxAgentEntry(payload);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DeregisterTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function persistRegistrationMetadata(params: {
  conn: DbConnection;
  actor: Agent;
  metadata: MasumiActorRegistrationMetadata | null | undefined;
}): Promise<void> {
  const masumiRegistrationNetwork =
    params.metadata?.masumiRegistrationNetwork?.trim() || undefined;
  const masumiInboxAgentId =
    params.metadata?.masumiInboxAgentId?.trim() || undefined;
  const masumiAgentIdentifier =
    params.metadata?.masumiAgentIdentifier?.trim() || undefined;
  const masumiRegistrationState = granularToRowState(
    params.metadata?.masumiRegistrationState
  );
  const hasAnyRegistrationValue = Boolean(
    masumiRegistrationNetwork ||
      masumiInboxAgentId ||
      masumiAgentIdentifier ||
      masumiRegistrationState
  );

  if (
    hasAnyRegistrationValue &&
    (!masumiRegistrationNetwork || !masumiInboxAgentId || !masumiRegistrationState)
  ) {
    return;
  }

  try {
    await params.conn.reducers.upsertMasumiRegistration({
      agentDbId: params.actor.id,
      masumiRegistrationNetwork,
      masumiInboxAgentId,
      masumiAgentIdentifier,
      masumiRegistrationState,
    });
  } catch (error) {
    if (
      !masumiAgentIdentifier &&
      isMasumiRegistrationTupleValidationError(error)
    ) {
      return;
    }
    throw error;
  }
}

function isMasumiRegistrationTupleValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('masumi_* fields') ||
    message.includes('masumiRegistrationNetwork, masumiInboxAgentId')
  );
}

async function persistPublicLinkedEmailVisibility(params: {
  conn: DbConnection;
  actor: Agent;
  enabled: boolean;
}): Promise<void> {
  await params.conn.reducers.updateAgentProfile({
    agentDbId: params.actor.id,
    displayName: undefined,
    publicDescription: undefined,
    publicLinkedEmailEnabled: params.enabled,
    allowAllMessageContentTypes: undefined,
    allowAllMessageHeaders: undefined,
    supportedMessageContentTypes: undefined,
    supportedMessageHeaderNames: undefined,
  });
}

async function persistPublicDescription(params: {
  conn: DbConnection;
  actor: Agent;
  description: string;
}): Promise<void> {
  await params.conn.reducers.updateAgentProfile({
    agentDbId: params.actor.id,
    displayName: undefined,
    publicDescription: params.description.trim() || undefined,
    publicLinkedEmailEnabled: undefined,
    allowAllMessageContentTypes: undefined,
    allowAllMessageHeaders: undefined,
    supportedMessageContentTypes: undefined,
    supportedMessageHeaderNames: undefined,
  });
}

async function waitForOwnedAgentBySlug(params: {
  conn: DbConnection;
  accountId: bigint;
  slug: string;
}): Promise<Agent | null> {
  const timeoutAt = Date.now() + IMPORTED_AGENT_SYNC_TIMEOUT_MS;
  while (Date.now() < timeoutAt) {
    const actor =
      (await readAccounts(params.conn)).actors.find(
        candidate =>
          candidate.accountId === params.accountId && candidate.slug === params.slug
      ) ?? null;
    if (actor) {
      return actor;
    }
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }
  return null;
}

function readOwnedImportActors(params: {
  actors: Agent[];
  email: string;
}): { defaultActor: Agent | null; ownedActors: Agent[] } {
  const defaultActor =
    params.actors.find(actor => actor.email === params.email && actor.isDefault) ?? null;
  const ownedActors = defaultActor
    ? params.actors.filter(actor => actor.accountId === defaultActor.accountId)
    : params.actors.filter(actor => actor.email === params.email);

  return {
    defaultActor,
    ownedActors,
  };
}

async function persistImportedSaasAgentRegistration(params: {
  conn: DbConnection;
  actor: Agent;
  entry: MasumiInboxAgentEntry;
  seedPublicDescription?: boolean;
}): Promise<void> {
  const metadata = mergeMasumiRegistrationMetadataFromEntry({
    entry: params.entry,
    current: readActorRegistrationMetadata(params.actor),
    preserveCurrentAgentIdentifier: true,
  });
  await persistRegistrationMetadata({
    conn: params.conn,
    actor: params.actor,
    metadata,
  });
  if (
    params.seedPublicDescription !== false &&
    !params.actor.publicDescription?.trim() &&
    params.entry.description?.trim()
  ) {
    await persistPublicDescription({
      conn: params.conn,
      actor: params.actor,
      description: params.entry.description,
    });
  }
}

function isImportableSaasAgent(entry: MasumiInboxAgentEntry): boolean {
  return (
    entry.state === 'RegistrationConfirmed' ||
    isPendingMasumiInboxAgentState(entry.state)
  );
}

function isSlugConflictError(error: unknown): boolean {
  const message = describeUnknownError(error).toLowerCase();
  return message.includes('slug') && message.includes('use');
}

export async function importOwnedSaasInboxAgents(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  conn: DbConnection;
  email: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
  apply?: boolean;
}): Promise<OwnedSaasAgentImportSummary> {
  const summary = createEmptyOwnedSaasAgentImportSummary();
  const accessToken = hasMasumiAccessToken(params.session)
    ? params.session.accessToken.trim()
    : null;
  if (!accessToken) {
    pushImportItem(summary, {
      slug: '*',
      status: 'warning',
      message: 'Managed SaaS agent import skipped: Masumi access token is missing.',
    });
    return summary;
  }

  let entries: MasumiInboxAgentEntry[];
  try {
    entries = await listImportableOwnedPayInboxAgents({
      issuer: params.profile.issuer,
      accessToken,
    });
  } catch (error) {
    pushImportItem(summary, {
      slug: '*',
      status: 'warning',
      message: `Managed SaaS agent import skipped: ${describeUnknownError(error)}`,
    });
    return summary;
  }

  const apply = params.apply ?? true;
  const secretStore = params.secretStore ?? createSecretStore();

  for (const entry of entries) {
    const slug = normalizeInboxSlug(entry.agentSlug);
    if (!slug) {
      pushImportItem(summary, {
        slug: entry.agentSlug,
        status: 'warning',
        message: `Skipped SaaS agent with invalid slug \`${entry.agentSlug}\`.`,
      });
      continue;
    }
    if (!isImportableSaasAgent(entry)) {
      pushImportItem(summary, {
        slug,
        status: 'skipped',
        message: `Skipped deregistered SaaS agent ${slug}.`,
      });
      continue;
    }

    summary.checked += 1;
    let actors: Agent[];
    try {
      ({ actors } = await readAccounts(params.conn));
    } catch (error) {
      pushImportItem(summary, {
        slug,
        status: 'warning',
        message: `Managed SaaS agent import stopped: unable to read local agents: ${describeUnknownError(error)}`,
      });
      break;
    }
    const { defaultActor, ownedActors } = readOwnedImportActors({
      actors,
      email: params.email,
    });
    if (!defaultActor) {
      pushImportItem(summary, {
        slug,
        status: 'warning',
        message: `Cannot import SaaS agent ${slug}: no default local account agent is synced.`,
      });
      continue;
    }

    const existingOwnedActor =
      ownedActors.find(actor => actor.slug === slug) ?? null;
    if (existingOwnedActor) {
      if (apply) {
        try {
          await persistImportedSaasAgentRegistration({
            conn: params.conn,
            actor: existingOwnedActor,
            entry,
            seedPublicDescription: false,
          });
          const message = `Synced managed SaaS agent ${slug}.`;
          params.reporter.success(message);
          pushImportItem(summary, {
            slug,
            status: 'synced',
            message,
          });
        } catch (error) {
          const message = `Managed SaaS agent ${slug} is local, but registration metadata sync failed: ${describeUnknownError(error)}`;
          params.reporter.info(`Warning: ${message}`);
          pushImportItem(summary, {
            slug,
            status: 'warning',
            message,
          });
        }
      } else {
        pushImportItem(summary, {
          slug,
          status: 'present',
          message: `Managed SaaS agent ${slug} is present locally.`,
        });
      }
      continue;
    }

    if (!apply) {
      pushImportItem(summary, {
        slug,
        status: 'missing',
        message: `Managed SaaS agent ${slug} exists in SaaS but is missing locally.`,
      });
      continue;
    }

    let createdLocally = false;
    try {
      const keyPair = await getOrCreateStoredActorKeyPair({
        profile: params.profile,
        secretStore,
        identity: {
          email: params.email,
          slug,
          accountIdentifier: slug,
        },
      });
      await params.conn.reducers.createAgent({
        slug,
        displayName: entry.name.trim() || slug,
        encryptionPublicKey: keyPair.encryption.publicKey,
        keyBundleVersion: keyPair.encryption.keyVersion,
        encryptionAlgorithm: { tag: 'EcdhP256V1' },
        signingPublicKey: keyPair.signing.publicKey,
        signingAlgorithm: { tag: 'EcdsaP256Sha256V1' },
      });
      createdLocally = true;
      const createdActor = await waitForOwnedAgentBySlug({
        conn: params.conn,
        accountId: defaultActor.accountId,
        slug,
      });
      if (!createdActor) {
        pushImportItem(summary, {
          slug,
          status: 'warning',
          message: `Imported SaaS agent ${slug}, but the local row did not sync yet.`,
        });
        continue;
      }
      await persistImportedSaasAgentRegistration({
        conn: params.conn,
        actor: createdActor,
        entry,
      });
      const message = `Imported managed SaaS agent ${slug}.`;
      params.reporter.success(message);
      pushImportItem(summary, {
        slug,
        status: 'imported',
        message,
      });
    } catch (error) {
      const message = createdLocally
        ? `Managed SaaS agent ${slug} was created locally, but registration metadata sync failed: ${describeUnknownError(error)}`
        : isSlugConflictError(error)
          ? `Managed SaaS agent ${slug} was not imported: slug is already in use locally.`
          : `Managed SaaS agent ${slug} was not imported: ${describeUnknownError(error)}`;
      params.reporter.info(`Warning: ${message}`);
      pushImportItem(summary, {
        slug,
        status: 'warning',
        message,
      });
    }
  }

  if (summary.imported > 0 || summary.synced > 0) {
    params.reporter.success(
      `Managed SaaS agent import complete: ${summary.imported.toString()} imported, ${summary.synced.toString()} synced.`
    );
  }

  return summary;
}

export function applyRegistrationMetadataToActor(
  actor: Agent,
  metadata: MasumiActorRegistrationMetadata | null | undefined
): Agent {
  if (!metadata) {
    return actor;
  }

  return {
    ...actor,
    masumiRegistrationNetwork: metadata.masumiRegistrationNetwork,
    masumiInboxAgentId: metadata.masumiInboxAgentId,
    masumiAgentIdentifier: metadata.masumiAgentIdentifier,
    masumiRegistrationState: granularToRowState(metadata.masumiRegistrationState),
  };
}

export function createPendingRegistrationResult(): MasumiRegistrationResult {
  const result = createEmptyMasumiRegistrationResult();
  return {
    ...result,
    skipped: true,
  };
}

export async function syncMasumiInboxAgentRegistration(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  conn: DbConnection;
  actor: Agent;
  reporter: TaskReporter;
  mode: RegistrationMode;
  desiredLinkedEmailVisibility?: boolean;
  desiredPublicDescription?: string;
  confirmRegistration?: ConfirmRegistrationPrompt;
  confirmLinkedEmailVisibility?: ConfirmLinkedEmailPrompt;
  confirmPublicDescription?: ConfirmPublicDescriptionPrompt;
  pauseAfterBlocked?: PauseHandler;
}): Promise<SyncResult> {
  let result = registrationResultFromMetadata(readActorRegistrationMetadata(params.actor));
  const accessToken = hasMasumiAccessToken(params.session)
    ? params.session.accessToken.trim()
    : null;

  let currentMetadata = readActorRegistrationMetadata(params.actor);
  let creditsRemaining: number;
  const desiredPublicDescription = params.desiredPublicDescription?.trim() || null;

  if (
    desiredPublicDescription &&
    params.actor.publicDescription !== desiredPublicDescription
  ) {
    await persistPublicDescription({
      conn: params.conn,
      actor: params.actor,
      description: desiredPublicDescription,
    });
  }

  params.reporter.info('Phase: lookup');

  if (!accessToken) {
    const error = toScopeMessage(
      'Masumi access_token is unavailable for inbox-agent sync.',
      params.session
    );
    result = {
      ...result,
      status: currentMetadata ? result.status : 'scope_missing',
      error,
    };
    return { registration: result, metadata: currentMetadata };
  }

  if (params.mode === 'skip') {
    try {
      const discovered = await discoverInboxAgentBySlug({
        issuer: params.profile.issuer,
        session: params.session,
        slug: params.actor.slug,
        includeDeregistered:
          Boolean(currentMetadata?.masumiInboxAgentId) ||
          isAnyDeregistrationInboxAgentState(currentMetadata?.masumiRegistrationState),
      });

      if (discovered) {
        currentMetadata = mergeMasumiRegistrationMetadataFromEntry({
          entry: discovered,
          current: currentMetadata,
          preserveCurrentAgentIdentifier: true,
        });
        await persistRegistrationMetadata({
          conn: params.conn,
          actor: params.actor,
          metadata: currentMetadata,
        });

        result = registrationResultFromMetadata(currentMetadata);
        params.reporter.success('Phase: lookup complete');
        return { registration: result, metadata: currentMetadata };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to discover inbox-agent registration';
      result = {
        ...result,
        status: currentMetadata
          ? result.status
          : isMissingRequiredScopeMessage(message)
            ? 'scope_missing'
            : 'service_unavailable',
        error: isMissingRequiredScopeMessage(message)
          ? toScopeMessage(message, params.session)
          : message,
      };
      return { registration: result, metadata: currentMetadata };
    }

    if (currentMetadata && result.status !== 'failed') {
      return { registration: result, metadata: currentMetadata };
    }

    if (!currentMetadata) {
      result.skipped = true;
      result.status = 'skipped';
    }
    return { registration: result, metadata: currentMetadata };
  }

  let discoveredOwned: MasumiInboxAgentEntry | null;
  try {
    discoveredOwned = await discoverOwnedBlockingPayInboxAgentBySlug({
      issuer: params.profile.issuer,
      accessToken,
      slug: params.actor.slug,
    });

    if (discoveredOwned) {
      currentMetadata = mergeMasumiRegistrationMetadataFromEntry({
        entry: discoveredOwned,
        current: currentMetadata,
        preserveCurrentAgentIdentifier: true,
      });

      if (isOwnedSaasRegistrationBlockingFreshCreate(discoveredOwned.state)) {
        await persistRegistrationMetadata({
          conn: params.conn,
          actor: params.actor,
          metadata: currentMetadata,
        });
        result = registrationResultFromMetadata(currentMetadata);
        params.reporter.success('Phase: lookup complete');
        return { registration: result, metadata: currentMetadata };
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to discover owned inbox-agent registration';
    result = {
      ...result,
      status: isMissingRequiredScopeMessage(message)
        ? 'scope_missing'
        : 'service_unavailable',
      error: isMissingRequiredScopeMessage(message)
        ? toScopeMessage(message, params.session)
        : message,
    };
    return { registration: result, metadata: currentMetadata };
  }

  if (!discoveredOwned && hasTrustedLocalConfirmedRegistration(currentMetadata)) {
    result = registrationResultFromMetadata(currentMetadata);
    params.reporter.success('Phase: lookup complete');
    return { registration: result, metadata: currentMetadata };
  }

  try {
    creditsRemaining = await fetchCredits({
      issuer: params.profile.issuer,
      accessToken,
    });
    result.creditsRemaining = creditsRemaining;
    params.reporter.info(
      `Masumi credits: ${creditsRemaining.toString()} on ${getMasumiInboxAgentNetwork()}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load credits';
    result = {
      ...result,
      status: currentMetadata
        ? result.status
        : isMissingRequiredScopeMessage(message)
          ? 'scope_missing'
          : 'service_unavailable',
      error: isMissingRequiredScopeMessage(message)
        ? toScopeMessage(message, params.session)
        : message,
    };
    return { registration: result, metadata: currentMetadata };
  }

  if (creditsRemaining < MASUMI_INBOX_AGENT_REQUIRED_CREDITS) {
    result.status = 'insufficient_credits';
    result.creditsRemaining = creditsRemaining;
    result.error = toInsufficientCreditsMessage({ actorSlug: params.actor.slug });
    params.reporter.info(`Warning: ${result.error}`);
    if (params.pauseAfterBlocked) {
      await params.pauseAfterBlocked(result.error);
    }
    return { registration: result, metadata: currentMetadata };
  }

  let linkedEmailVisibility: boolean;
  let publicDescription: string | null;
  if (params.mode === 'prompt') {
    const shouldRegister = params.confirmRegistration
      ? await params.confirmRegistration({
          actorSlug: params.actor.slug,
          displayName: params.actor.displayName ?? null,
          creditsRemaining,
          network: getMasumiInboxAgentNetwork(),
        })
      : false;
    if (!shouldRegister) {
      result.skipped = true;
      result.status = 'skipped';
      return { registration: result, metadata: currentMetadata };
    }

    linkedEmailVisibility = params.confirmLinkedEmailVisibility
      ? await params.confirmLinkedEmailVisibility({
          actorSlug: params.actor.slug,
          displayName: params.actor.displayName ?? null,
        })
      : true;
    publicDescription =
      desiredPublicDescription ??
      (params.confirmPublicDescription
        ? await params.confirmPublicDescription({
            actorSlug: params.actor.slug,
            displayName: params.actor.displayName ?? null,
          })
        : null);
  } else {
    linkedEmailVisibility = params.desiredLinkedEmailVisibility ?? true;
    publicDescription = desiredPublicDescription;
  }

  result.attempted = true;
  params.reporter.info(`Registering inbox agent for ${params.actor.slug}`);
  const preAttemptMetadata = currentMetadata;

  try {
    params.reporter.info('Phase: register');
    const created = await registerInboxAgent({
      issuer: params.profile.issuer,
      accessToken,
      slug: params.actor.slug,
      displayName: params.actor.displayName ?? null,
      description: publicDescription,
    });

    if (created.kind === 'insufficient_credits') {
      currentMetadata = preAttemptMetadata;
      result.status = 'insufficient_credits';
      result.creditsRemaining = created.creditsRemaining;
      result.error = toInsufficientCreditsMessage({
        actorSlug: params.actor.slug,
        error: created.error,
      });
      params.reporter.info(`Warning: ${result.error}`);
      if (params.pauseAfterBlocked) {
        await params.pauseAfterBlocked(result.error);
      }
      return { registration: result, metadata: currentMetadata };
    }

    params.reporter.success('Phase: register complete');

    currentMetadata = mergeMasumiRegistrationMetadataFromEntry({
      entry: created.entry,
      current: preAttemptMetadata,
      preserveCurrentAgentIdentifier: true,
    });
    await persistRegistrationMetadata({
      conn: params.conn,
      actor: params.actor,
      metadata: currentMetadata,
    });
    await persistPublicLinkedEmailVisibility({
      conn: params.conn,
      actor: params.actor,
      enabled: linkedEmailVisibility,
    });
    if (publicDescription) {
      await persistPublicDescription({
        conn: params.conn,
        actor: params.actor,
        description: publicDescription,
      });
    }

    params.reporter.success('Phase: publish complete');

    result = {
      ...registrationResultFromMetadata(currentMetadata),
      attempted: true,
      creditsRemaining,
      error: null,
    };
    return { registration: result, metadata: currentMetadata };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to register inbox agent';

    if (isInboxAgentSlugConflictMessage(message)) {
      try {
        const ownedAfterConflict = await discoverOwnedPayInboxAgentBySlug({
          issuer: params.profile.issuer,
          accessToken,
          slug: params.actor.slug,
          fullScanOnMiss: true,
        });
        if (ownedAfterConflict) {
          currentMetadata = mergeMasumiRegistrationMetadataFromEntry({
            entry: ownedAfterConflict,
            current: preAttemptMetadata,
            preserveCurrentAgentIdentifier: true,
          });
          await persistRegistrationMetadata({
            conn: params.conn,
            actor: params.actor,
            metadata: currentMetadata,
          });
          await persistPublicLinkedEmailVisibility({
            conn: params.conn,
            actor: params.actor,
            enabled: linkedEmailVisibility,
          });
          result = {
            ...registrationResultFromMetadata(currentMetadata),
            attempted: true,
            creditsRemaining,
            error: null,
          };
          params.reporter.success('Phase: lookup complete');
          return { registration: result, metadata: currentMetadata };
        }
      } catch {
        // Keep the original conflict visible if the reconciliation lookup fails.
      }
    }

    // Network/connectivity errors are transient — don't overwrite a prior
    // RegistrationConfirmed state as RegistrationFailed. Revert to pre-attempt
    // metadata and surface a service_unavailable status so the next sync retries.
    if (isNetworkLikeError(error)) {
      currentMetadata = preAttemptMetadata;
      result = {
        ...registrationResultFromMetadata(currentMetadata),
        attempted: true,
        creditsRemaining,
        status: preAttemptMetadata ? result.status : 'service_unavailable',
        error: message,
      };
      return { registration: result, metadata: currentMetadata };
    }

    currentMetadata = preAttemptMetadata;
    if (isMissingRequiredScopeMessage(message)) {
      result.status = 'scope_missing';
      result.error = toScopeMessage(message, params.session);
      return { registration: result, metadata: currentMetadata };
    }
    result = {
      ...registrationResultFromMetadata(currentMetadata),
      attempted: true,
      creditsRemaining,
      status: 'failed',
      error: message,
    };
    return { registration: result, metadata: currentMetadata };
  }
}

export async function deregisterMasumiInboxAgentRegistration(params: {
  profile: ResolvedProfile;
  session: StoredOidcSession;
  conn: DbConnection;
  actor: Agent;
  reporter: TaskReporter;
}): Promise<SyncResult> {
  const localMetadata = readActorRegistrationMetadata(params.actor);
  const accessToken = hasMasumiAccessToken(params.session)
    ? params.session.accessToken.trim()
    : null;
  if (!accessToken) {
    throw userError(
      toScopeMessage(
        'Masumi access_token is unavailable for inbox-agent deregistration.',
        params.session
      ),
      {
        code: 'MASUMI_SCOPE_MISSING',
      }
    );
  }

  params.reporter.info('Phase: lookup');
  const discovered = await discoverOwnedPayInboxAgentBySlug({
    issuer: params.profile.issuer,
    accessToken,
    slug: params.actor.slug,
  });
  let currentMetadata = discovered
    ? mergeMasumiRegistrationMetadataFromEntry({
        entry: discovered,
        current: localMetadata,
        preserveCurrentAgentIdentifier: true,
      })
    : isDeregisterableRegistrationMetadata(localMetadata)
      ? localMetadata
      : null;

  if (!isDeregisterableRegistrationMetadata(currentMetadata)) {
    const state = currentMetadata?.masumiRegistrationState ?? 'not registered';
    throw userError(
      `Inbox agent ${params.actor.slug} cannot be deregistered while its state is ${state}.`,
      {
        code: 'INBOX_AGENT_NOT_DEREGISTERABLE',
        hint: `masumi-agent-messenger agent network sync ${params.actor.slug}`,
      }
    );
  }

  params.reporter.success('Phase: lookup complete');
  params.reporter.info(`Deregistering inbox agent for ${params.actor.slug}`);

  const deregistered = await requestInboxAgentDeregistration({
    issuer: params.profile.issuer,
    accessToken,
    inboxAgentId: currentMetadata.masumiInboxAgentId,
  }).catch(async error => {
    // Masumi processes deregistration asynchronously. On timeout, skip the
    // direct response and re-discover the current state so the local actor
    // row is updated to whatever Masumi committed.
    if (!(error instanceof DeregisterTimeoutError)) {
      throw error;
    }
    params.reporter.info('Deregister request timed out; syncing state');
    return discoverInboxAgentBySlug({
      issuer: params.profile.issuer,
      session: params.session,
      slug: params.actor.slug,
      includeDeregistered: true,
    });
  });

  if (!deregistered) {
    // No state visible from Masumi after timeout — leave local metadata as-is
    // so a later sync can reconcile.
    return {
      registration: {
        ...registrationResultFromMetadata(currentMetadata),
        attempted: true,
        status: 'service_unavailable',
        error: 'Deregister request is still in flight; re-run sync to update state.',
      },
      metadata: currentMetadata,
    };
  }

  currentMetadata = mergeMasumiRegistrationMetadataFromEntry({
    entry: deregistered,
    current: currentMetadata,
    preserveCurrentAgentIdentifier: true,
  });
  await persistRegistrationMetadata({
    conn: params.conn,
    actor: params.actor,
    metadata: currentMetadata,
  });
  params.reporter.success('Phase: deregister complete');

  return {
    registration: {
      ...registrationResultFromMetadata(currentMetadata),
      attempted: true,
      error: null,
    },
    metadata: currentMetadata,
  };
}
