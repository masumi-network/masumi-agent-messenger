import type { paths as MasumiOpenApiPaths } from './generated-masumi-openapi';
import { GENERATED_MASUMI_NETWORK } from './generated-oidc-config';

export type MasumiInboxAgentNetwork = 'Preprod' | 'Mainnet';

export function getMasumiInboxAgentNetwork(): MasumiInboxAgentNetwork {
  return GENERATED_MASUMI_NETWORK;
}
export const MASUMI_INBOX_AGENT_REQUIRED_CREDITS = 1;
export const DEFAULT_MASUMI_DISCOVERY_PAGE_SIZE = 20;
export const MAX_MASUMI_DISCOVERY_PAGE_SIZE = 50;

export const MASUMI_INBOX_AGENT_STATES = [
  'RegistrationRequested',
  'RegistrationInitiated',
  'RegistrationConfirmed',
  'RegistrationFailed',
  'DeregistrationRequested',
  'DeregistrationInitiated',
  'DeregistrationConfirmed',
  'DeregistrationFailed',
] as const;

export type MasumiInboxAgentState = (typeof MASUMI_INBOX_AGENT_STATES)[number];

export const MASUMI_REGISTRATION_OUTCOMES = [
  'registered',
  'already_registered_or_discovered',
  'pending',
  'skipped',
  'insufficient_credits',
  'scope_missing',
  'service_unavailable',
  'failed',
] as const;

export type MasumiRegistrationOutcome = (typeof MASUMI_REGISTRATION_OUTCOMES)[number];

export function masumiRegistrationOutcomeToHttpStatus(
  outcome: MasumiRegistrationOutcome
): number {
  switch (outcome) {
    case 'registered':
      return 201;
    case 'already_registered_or_discovered':
      return 200;
    case 'pending':
      return 202;
    case 'skipped':
      return 404;
    case 'insufficient_credits':
      return 402;
    case 'scope_missing':
      return 403;
    case 'service_unavailable':
      return 503;
    case 'failed':
      return 502;
    default:
      return 500;
  }
}

export type MasumiActorRegistrationMetadata = {
  masumiRegistrationNetwork?: string;
  masumiInboxAgentId?: string;
  masumiAgentIdentifier?: string;
  masumiRegistrationState?: MasumiInboxAgentState;
};

export type SerializedMasumiActorRegistrationMetadata = {
  masumiRegistrationNetwork?: string;
  masumiInboxAgentId?: string;
  masumiAgentIdentifier?: string;
  masumiRegistrationState?: MasumiInboxAgentState;
};

export type SerializedMasumiActorRegistrationSubject = {
  slug: string;
  displayName: string | null;
  registration: SerializedMasumiActorRegistrationMetadata | null;
};

export type SerializedMasumiRegistrationResponse = {
  registration: MasumiRegistrationResult;
  metadata: SerializedMasumiActorRegistrationMetadata | null;
};

export type MasumiRegistrationResult = {
  network: MasumiInboxAgentNetwork;
  creditsRemaining: number | null;
  attempted: boolean;
  skipped: boolean;
  status: MasumiRegistrationOutcome;
  inboxAgentId: string | null;
  agentIdentifier: string | null;
  registrationState: MasumiInboxAgentState | null;
  error: string | null;
};

export type MasumiInboxAgentEntry = {
  id: string;
  name: string;
  description: string | null;
  agentSlug: string;
  linkedEmail?: string | null;
  state: MasumiInboxAgentState;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  agentIdentifier: string | null;
};

export type SerializedMasumiInboxAgentSearchResponse = {
  agents: MasumiInboxAgentEntry[];
  page: number;
  take: number;
  hasNextPage: boolean;
};

type RegistryInboxAgentBrowseEndpoint =
  MasumiOpenApiPaths['/registry/api/v1/inbox-agent-registration']['post'];
type RegistryInboxAgentSearchEndpoint =
  MasumiOpenApiPaths['/registry/api/v1/inbox-agent-registration-search']['post'];
type PayInboxAgentsEndpoint = MasumiOpenApiPaths['/pay/api/v1/inbox-agents']['post'];
type ApiCreditsEndpoint = MasumiOpenApiPaths['/api/credits']['get'];

export type MasumiRegistryInboxAgentBrowseRequest = NonNullable<
  RegistryInboxAgentBrowseEndpoint['requestBody']
>['content']['application/json'];

export type MasumiRegistryInboxAgentSearchRequest = NonNullable<
  RegistryInboxAgentSearchEndpoint['requestBody']
>['content']['application/json'];

export type MasumiRegistryInboxAgentBrowseResponse =
  RegistryInboxAgentBrowseEndpoint['responses'][200]['content']['application/json'];

export type MasumiRegistryInboxAgentSearchResponse =
  RegistryInboxAgentSearchEndpoint['responses'][200]['content']['application/json'];

export type MasumiRegistryInboxAgentRecord =
  MasumiRegistryInboxAgentBrowseResponse['data']['registrations'][number];

export type MasumiRegistryInboxAgentStatus = NonNullable<
  NonNullable<MasumiRegistryInboxAgentBrowseRequest['filter']>['status']
>[number];

export type MasumiPayInboxAgentCreateRequest = NonNullable<
  PayInboxAgentsEndpoint['requestBody']
>['content']['application/json'];

export type MasumiPayInboxAgentCreateResponse =
  PayInboxAgentsEndpoint['responses'][200]['content']['application/json'];

export type MasumiPayInboxAgentRecord = MasumiPayInboxAgentCreateResponse['data'];
export type MasumiApiCreditsResponse =
  ApiCreditsEndpoint['responses'][200]['content']['application/json'];
export type MasumiApiCreditsData = MasumiApiCreditsResponse['data'];

export function buildMasumiBaseUrl(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

export function buildMasumiApiUrl(issuer: string, path: string): URL {
  return new URL(`/api/${path.replace(/^\/+/, '')}`, buildMasumiBaseUrl(issuer));
}

export function buildMasumiApiV1Url(issuer: string, path: string): URL {
  return new URL(`/api/v1/${path.replace(/^\/+/, '')}`, buildMasumiBaseUrl(issuer));
}

export function buildMasumiRegistryApiUrl(issuer: string, path: string): URL {
  return new URL(`/registry/api/v1/${path.replace(/^\/+/, '')}`, buildMasumiBaseUrl(issuer));
}

export function buildMasumiPayApiUrl(issuer: string, path: string): URL {
  return new URL(`/pay/api/v1/${path.replace(/^\/+/, '')}`, buildMasumiBaseUrl(issuer));
}

export function buildMasumiRegistryInboxAgentBrowseRequest(params: {
  limit: number;
  cursorId?: string;
  agentSlug?: string;
  statuses?: MasumiRegistryInboxAgentStatus[];
  network?: MasumiInboxAgentNetwork;
}): MasumiRegistryInboxAgentBrowseRequest {
  return {
    network: params.network ?? getMasumiInboxAgentNetwork(),
    limit: params.limit,
    ...(params.cursorId ? { cursorId: params.cursorId } : {}),
    ...(params.agentSlug || params.statuses?.length
      ? {
          filter: {
            ...(params.agentSlug ? { agentSlug: params.agentSlug } : {}),
            ...(params.statuses?.length ? { status: params.statuses } : {}),
          },
        }
      : {}),
  };
}

export function buildMasumiRegistryInboxAgentSearchRequest(params: {
  query: string;
  limit: number;
  cursorId?: string;
  statuses?: MasumiRegistryInboxAgentStatus[];
  network?: MasumiInboxAgentNetwork;
}): MasumiRegistryInboxAgentSearchRequest {
  return {
    network: params.network ?? getMasumiInboxAgentNetwork(),
    query: params.query,
    limit: params.limit,
    ...(params.cursorId ? { cursorId: params.cursorId } : {}),
    ...(params.statuses?.length
      ? {
          filter: {
            status: params.statuses,
          },
        }
      : {}),
  };
}

export function buildMasumiPayInboxAgentCreateRequest(params: {
  name: string;
  description?: string;
  agentSlug: string;
}): MasumiPayInboxAgentCreateRequest {
  const description = params.description?.trim();
  return {
    name: params.name,
    ...(description ? { description } : {}),
    agentSlug: params.agentSlug,
  };
}

export function normalizeMasumiDiscoveryTake(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MASUMI_DISCOVERY_PAGE_SIZE;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Search result count must be a positive integer.');
  }

  return Math.min(value, MAX_MASUMI_DISCOVERY_PAGE_SIZE);
}

export function normalizeMasumiDiscoveryPage(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Page must be a positive integer.');
  }

  return value;
}

export function createEmptyMasumiRegistrationResult(): MasumiRegistrationResult {
  return {
    network: getMasumiInboxAgentNetwork(),
    creditsRemaining: null,
    attempted: false,
    skipped: false,
    status: 'skipped',
    inboxAgentId: null,
    agentIdentifier: null,
    registrationState: null,
    error: null,
  };
}

export function isMissingRequiredScopeMessage(message: string | undefined): boolean {
  return Boolean(message && message.startsWith('Missing required scope: '));
}

export function isMasumiInboxAgentState(value: string): value is MasumiInboxAgentState {
  return (MASUMI_INBOX_AGENT_STATES as readonly string[]).includes(value);
}

export function toMasumiInboxAgentState(value: string | null): MasumiInboxAgentState {
  if (!value) {
    throw new Error('Masumi inbox-agent entry is invalid');
  }

  if (isMasumiInboxAgentState(value)) {
    return value;
  }

  switch (value) {
    case 'Pending':
      return 'RegistrationRequested';
    case 'Verified':
      return 'RegistrationConfirmed';
    case 'Invalid':
      return 'RegistrationFailed';
    case 'Deregistered':
      return 'DeregistrationConfirmed';
    default:
      throw new Error('Masumi inbox-agent entry is invalid');
  }
}

export function isNonDeregisteredInboxAgentState(
  state: MasumiInboxAgentState
): boolean {
  return state !== 'DeregistrationConfirmed';
}

export function masumiRegistrationOutcomeFromState(
  state: MasumiInboxAgentState | null | undefined
): MasumiRegistrationOutcome | null {
  switch (state) {
    case 'RegistrationRequested':
    case 'RegistrationInitiated':
    case 'DeregistrationRequested':
    case 'DeregistrationInitiated':
      return 'pending';
    case 'RegistrationConfirmed':
      return 'registered';
    case 'RegistrationFailed':
    case 'DeregistrationFailed':
      return 'failed';
    case 'DeregistrationConfirmed':
      return 'skipped';
    case undefined:
    case null:
      return null;
    default:
      return null;
  }
}

export function fromMasumiRegistryInboxAgentRecord(
  record: MasumiRegistryInboxAgentRecord
): MasumiInboxAgentEntry {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? null,
    agentSlug: record.agentSlug,
    linkedEmail: record.linkedEmail ?? null,
    state: toMasumiInboxAgentState('status' in record ? record.status ?? null : null),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastCheckedAt:
      'statusUpdatedAt' in record && typeof record.statusUpdatedAt === 'string'
        ? record.statusUpdatedAt
        : null,
    agentIdentifier: record.agentIdentifier ?? null,
  };
}

export function fromMasumiPayInboxAgentRecord(
  record: MasumiPayInboxAgentRecord
): MasumiInboxAgentEntry {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? null,
    agentSlug: record.agentSlug,
    linkedEmail: null,
    state: toMasumiInboxAgentState(record.state),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastCheckedAt: record.lastCheckedAt,
    agentIdentifier: record.agentIdentifier ?? null,
  };
}

export function parseMasumiPayInboxAgentEntry(value: unknown): MasumiInboxAgentEntry {
  if (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null
  ) {
    return fromMasumiPayInboxAgentRecord(value.data as MasumiPayInboxAgentRecord);
  }

  throw new Error('Masumi inbox-agent response is invalid');
}

export function parseMasumiRegistryInboxAgentCollection(value: unknown): {
  agents: MasumiInboxAgentEntry[];
  nextCursor: string | null;
} {
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'success' &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'registrations' in value.data &&
    Array.isArray(value.data.registrations)
  ) {
    const registrations = value.data
      .registrations as MasumiRegistryInboxAgentRecord[];
    const agents = registrations.map(fromMasumiRegistryInboxAgentRecord);
    return {
      agents,
      nextCursor: agents.length > 0 ? agents[agents.length - 1]?.id ?? null : null,
    };
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'data' in value &&
    Array.isArray(value.data)
  ) {
    const agents = (value.data as MasumiInboxAgentEntry[]).map(entry => ({
      ...entry,
      state: toMasumiInboxAgentState(entry.state),
    }));
    return {
      agents,
      nextCursor: agents.length > 0 ? agents[agents.length - 1]?.id ?? null : null,
    };
  }

  throw new Error('Masumi inbox-agent list response is invalid');
}

export function normalizeInboxAgentSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function pickNewestExactInboxAgentMatch(params: {
  entries: MasumiInboxAgentEntry[];
  slug: string;
}): MasumiInboxAgentEntry | null {
  const normalizedSlug = normalizeInboxAgentSlug(params.slug);
  const matches = params.entries
    .filter(entry => normalizeInboxAgentSlug(entry.agentSlug) === normalizedSlug)
    .filter(entry => isNonDeregisteredInboxAgentState(entry.state))
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt);
      const rightTime = Date.parse(right.updatedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
        return rightTime - leftTime;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });

  return matches[0] ?? null;
}

export function registrationMetadataFromEntry(
  entry: MasumiInboxAgentEntry
): MasumiActorRegistrationMetadata {
  return {
    masumiRegistrationNetwork: getMasumiInboxAgentNetwork(),
    masumiInboxAgentId: entry.id,
    masumiAgentIdentifier: entry.agentIdentifier ?? undefined,
    masumiRegistrationState: entry.state,
  };
}

export function createRegistrationRequestedMetadata(params: {
  current: MasumiActorRegistrationMetadata | null | undefined;
}): MasumiActorRegistrationMetadata {
  return {
    masumiRegistrationNetwork:
      params.current?.masumiRegistrationNetwork ?? getMasumiInboxAgentNetwork(),
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: 'RegistrationRequested',
  };
}

export function createRegistrationFailedMetadata(params: {
  current: MasumiActorRegistrationMetadata | null | undefined;
}): MasumiActorRegistrationMetadata {
  return {
    masumiRegistrationNetwork:
      params.current?.masumiRegistrationNetwork ?? getMasumiInboxAgentNetwork(),
    masumiInboxAgentId: undefined,
    masumiAgentIdentifier: undefined,
    masumiRegistrationState: 'RegistrationFailed',
  };
}

export function registrationResultFromMetadata(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): MasumiRegistrationResult {
  const result = createEmptyMasumiRegistrationResult();
  if (!metadata) {
    return result;
  }

  const registrationState = metadata.masumiRegistrationState ?? null;
  const stateOutcome = masumiRegistrationOutcomeFromState(registrationState);
  const fallbackStatus = metadata.masumiAgentIdentifier
    ? 'registered'
    : metadata.masumiInboxAgentId
      ? 'pending'
      : result.status;

  return {
    ...result,
    status: stateOutcome ?? fallbackStatus,
    inboxAgentId: metadata.masumiInboxAgentId ?? null,
    agentIdentifier: metadata.masumiAgentIdentifier ?? null,
    registrationState: metadata.masumiRegistrationState ?? null,
  };
}

export function applyMasumiRegistrationMetadata<
  T extends Record<string, unknown>,
>(target: T, metadata: MasumiActorRegistrationMetadata | null | undefined): T & MasumiActorRegistrationMetadata {
  return {
    ...target,
    masumiRegistrationNetwork: metadata?.masumiRegistrationNetwork,
    masumiInboxAgentId: metadata?.masumiInboxAgentId,
    masumiAgentIdentifier: metadata?.masumiAgentIdentifier,
    masumiRegistrationState: metadata?.masumiRegistrationState,
  };
}

export function serializeMasumiRegistrationMetadata(
  metadata: MasumiActorRegistrationMetadata | null | undefined
): SerializedMasumiActorRegistrationMetadata | null {
  if (!metadata) {
    return null;
  }

  return {
    masumiRegistrationNetwork: metadata.masumiRegistrationNetwork,
    masumiInboxAgentId: metadata.masumiInboxAgentId,
    masumiAgentIdentifier: metadata.masumiAgentIdentifier,
    masumiRegistrationState: metadata.masumiRegistrationState,
  };
}

export function deserializeMasumiRegistrationMetadata(
  metadata: SerializedMasumiActorRegistrationMetadata | null | undefined
): MasumiActorRegistrationMetadata | null {
  if (!metadata) {
    return null;
  }

  return {
    masumiRegistrationNetwork: metadata.masumiRegistrationNetwork,
    masumiInboxAgentId: metadata.masumiInboxAgentId,
    masumiAgentIdentifier: metadata.masumiAgentIdentifier,
    masumiRegistrationState: metadata.masumiRegistrationState,
  };
}
