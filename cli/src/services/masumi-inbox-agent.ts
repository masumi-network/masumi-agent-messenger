import {
  type DbConnection,
} from '../../../webapp/src/module_bindings';
import type { VisibleAgentRow } from '../../../webapp/src/module_bindings/types';
import {
  type MasumiApiCreditsData,
  buildMasumiPayInboxAgentCreateRequest,
  buildMasumiApiUrl,
  buildMasumiRegistryInboxAgentBrowseRequest,
  buildMasumiRegistryInboxAgentSearchRequest,
  buildMasumiPayApiUrl,
  buildMasumiRegistryApiUrl,
  createRegistrationFailedMetadata,
  createRegistrationRequestedMetadata,
  createEmptyMasumiRegistrationResult,
  parseMasumiRegistryInboxAgentCollection,
  parseMasumiPayInboxAgentEntry,
  isMasumiInboxAgentState,
  isNonDeregisteredInboxAgentState,
  isMissingRequiredScopeMessage,
  getMasumiInboxAgentNetwork,
  type MasumiInboxAgentNetwork,
  MASUMI_INBOX_AGENT_REQUIRED_CREDITS,
  type MasumiRegistryInboxAgentStatus,
  normalizeMasumiDiscoveryPage,
  normalizeMasumiDiscoveryTake,
  type MasumiActorRegistrationMetadata,
  type MasumiInboxAgentEntry,
  type MasumiRegistrationResult,
  pickNewestExactInboxAgentMatch,
  registrationMetadataFromEntry,
  registrationResultFromMetadata,
  type SerializedMasumiInboxAgentSearchResponse,
} from '../../../shared/inbox-agent-registration';
import { normalizeEmail, normalizeInboxSlug } from '../../../shared/inbox-slug';
import type { TaskReporter } from './command-runtime';
import type { ResolvedProfile } from './config-store';
import type { StoredOidcSession } from './oidc';

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

type ErrorBody = {
  error?: string;
  creditsRemaining?: number;
  requiredCredits?: number;
};

type PaginatedInboxAgentParams = {
  issuer: string;
  session: StoredOidcSession;
  search?: string;
  take?: number;
  page?: number;
  filterStatuses?: MasumiRegistryInboxAgentStatus[];
  agentSlug?: string;
};

function discoveryStatuses(params: {
  allowPending?: boolean;
}): MasumiRegistryInboxAgentStatus[] {
  return params.allowPending ? ['Pending', 'Verified'] : ['Verified'];
}

function dedupeMasumiInboxAgents(entries: MasumiInboxAgentEntry[]): MasumiInboxAgentEntry[] {
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

async function fetchCredits(params: {
  issuer: string;
  accessToken: string;
}): Promise<number> {
  const creditsUrl = buildMasumiApiUrl(params.issuer, 'credits');
  creditsUrl.searchParams.set('network', getMasumiInboxAgentNetwork());
  const response = await fetch(creditsUrl, {
    headers: buildHeaders(params.accessToken),
  });

  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(body.error ?? `Unable to load credits (${response.status})`);
  }

  const payload = parseCreditsPayload(await response.json());
  return payload.creditsRemaining;
}

async function fetchMasumiInboxAgentRegistrations(
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
    const response = await fetch(url, {
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

async function findMasumiInboxAgentsByLinkedEmail(params: {
  issuer: string;
  session: StoredOidcSession;
  search: string;
  take: number;
  filterStatuses: MasumiRegistryInboxAgentStatus[];
}): Promise<MasumiInboxAgentEntry[]> {
  const normalizedEmail = normalizeEmail(params.search);
  const normalizedEmailSlug = normalizeInboxSlug(params.search);
  if (!normalizedEmail.includes('@') && !normalizedEmailSlug.includes('-')) {
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
        normalizeEmail(linkedEmail) === normalizedEmail ||
        normalizeInboxSlug(linkedEmail) === normalizedEmailSlug
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
    const response = await fetch(url, {
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
}): Promise<MasumiInboxAgentEntry | null> {
  const entries = await fetchMasumiInboxAgentRegistrations({
    issuer: params.issuer,
    session: params.session,
    agentSlug: params.slug,
    take: 20,
    page: 1,
    filterStatuses: ['Pending', 'Verified'],
  });
  return pickNewestExactInboxAgentMatch({
    entries: entries.agents,
    slug: params.slug,
  });
}

async function registerInboxAgent(params: {
  issuer: string;
  accessToken: string;
  slug: string;
  displayName: string | null;
}): Promise<
  | { kind: 'success'; entry: MasumiInboxAgentEntry }
  | { kind: 'insufficient_credits'; creditsRemaining: number | null; error: string }
> {
  const url = buildMasumiPayApiUrl(params.issuer, 'inbox-agents');
  url.searchParams.set('network', getMasumiInboxAgentNetwork());

  const response = await fetch(url, {
    method: 'POST',
    headers: (() => {
      const headers = buildHeaders(params.accessToken);
      headers.set('Content-Type', 'application/json');
      return headers;
    })(),
    body: JSON.stringify(
      buildMasumiPayInboxAgentCreateRequest({
        name: params.displayName?.trim() || params.slug,
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

async function persistRegistrationMetadata(params: {
  conn: DbConnection;
  actor: VisibleAgentRow;
  metadata: MasumiActorRegistrationMetadata | null | undefined;
}): Promise<void> {
  const payload = {
    agentDbId: params.actor.id,
    masumiRegistrationNetwork: params.metadata?.masumiRegistrationNetwork,
    masumiInboxAgentId: params.metadata?.masumiInboxAgentId,
    masumiAgentIdentifier: params.metadata?.masumiAgentIdentifier,
    masumiRegistrationState: params.metadata?.masumiRegistrationState,
  };

  await params.conn.reducers.upsertMasumiInboxAgentRegistration(payload);
}

async function persistPublicLinkedEmailVisibility(params: {
  conn: DbConnection;
  actor: VisibleAgentRow;
  enabled: boolean;
}): Promise<void> {
  await params.conn.reducers.setAgentPublicLinkedEmailVisibility({
    agentDbId: params.actor.id,
    enabled: params.enabled,
  });
}

async function persistPublicDescription(params: {
  conn: DbConnection;
  actor: VisibleAgentRow;
  description: string;
}): Promise<void> {
  await params.conn.reducers.setAgentPublicDescription({
    agentDbId: params.actor.id,
    description: params.description.trim() || undefined,
  });
}

export function applyRegistrationMetadataToActor(
  actor: VisibleAgentRow,
  metadata: MasumiActorRegistrationMetadata | null | undefined
): VisibleAgentRow {
  if (!metadata) {
    return actor;
  }

  return {
    ...actor,
    masumiRegistrationNetwork: metadata.masumiRegistrationNetwork,
    masumiInboxAgentId: metadata.masumiInboxAgentId,
    masumiAgentIdentifier: metadata.masumiAgentIdentifier,
    masumiRegistrationState: metadata.masumiRegistrationState,
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
  actor: VisibleAgentRow;
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
  let creditsRemaining: number | null = null;

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

  try {
    const discovered = await discoverInboxAgentBySlug({
      issuer: params.profile.issuer,
      session: params.session,
      slug: params.actor.slug,
    });

    if (discovered) {
      currentMetadata = registrationMetadataFromEntry(discovered);
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

  if (params.mode === 'skip') {
    if (!currentMetadata) {
      result.skipped = true;
      result.status = 'skipped';
    }
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

  if (
    creditsRemaining !== null &&
    creditsRemaining < MASUMI_INBOX_AGENT_REQUIRED_CREDITS
  ) {
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
    publicDescription = params.confirmPublicDescription
      ? await params.confirmPublicDescription({
          actorSlug: params.actor.slug,
          displayName: params.actor.displayName ?? null,
        })
      : null;
  } else {
    linkedEmailVisibility = params.desiredLinkedEmailVisibility ?? true;
    publicDescription =
      params.desiredPublicDescription?.trim().length
        ? params.desiredPublicDescription
        : null;
  }

  result.attempted = true;
  params.reporter.info(`Registering inbox agent for ${params.actor.slug}`);
  const preAttemptMetadata = currentMetadata;
  currentMetadata = createRegistrationRequestedMetadata({
    current: currentMetadata,
  });
  await persistRegistrationMetadata({
    conn: params.conn,
    actor: params.actor,
    metadata: currentMetadata,
  });

  try {
    params.reporter.info('Phase: register');
    const created = await registerInboxAgent({
      issuer: params.profile.issuer,
      accessToken,
      slug: params.actor.slug,
      displayName: params.actor.displayName ?? null,
    });

    if (created.kind === 'insufficient_credits') {
      currentMetadata = preAttemptMetadata;
      await persistRegistrationMetadata({
        conn: params.conn,
        actor: params.actor,
        metadata: currentMetadata,
      });
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

    currentMetadata = registrationMetadataFromEntry(created.entry);
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
    currentMetadata = createRegistrationFailedMetadata({
      current: preAttemptMetadata,
    });
    await persistRegistrationMetadata({
      conn: params.conn,
      actor: params.actor,
      metadata: currentMetadata,
    });
    const message =
      error instanceof Error ? error.message : 'Unable to register inbox agent';
    if (isMissingRequiredScopeMessage(message)) {
      result.status = 'scope_missing';
      result.error = toScopeMessage(message, params.session);
      return { registration: result, metadata: currentMetadata };
    }
    result = {
      ...registrationResultFromMetadata(currentMetadata),
      attempted: true,
      creditsRemaining,
      error: message,
    };
    return { registration: result, metadata: currentMetadata };
  }
}
