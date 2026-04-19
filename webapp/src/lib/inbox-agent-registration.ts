import {
  applyMasumiRegistrationMetadata,
  createRegistrationFailedMetadata,
  createRegistrationRequestedMetadata,
  deserializeMasumiRegistrationMetadata,
  type MasumiActorRegistrationMetadata,
  serializeMasumiRegistrationMetadata,
  isMasumiInboxAgentState,
  type MasumiRegistrationResult,
  type SerializedMasumiInboxAgentSearchResponse,
  type SerializedMasumiActorRegistrationSubject,
  type SerializedMasumiRegistrationResponse,
} from '../../../shared/inbox-agent-registration';
import type { Agent } from '@/module_bindings/types';
import type { UpsertMasumiInboxAgentRegistrationParams } from '@/module_bindings/types/reducers';
import type { AuthenticatedBrowserSession } from './auth-session';

type PersistRegistration = (
  params: UpsertMasumiInboxAgentRegistrationParams
) => Promise<unknown>;

export function readActorRegistrationMetadata(
  actor: Agent
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

function shouldPersistRegistrationMetadata(
  current: MasumiActorRegistrationMetadata | null,
  next: MasumiActorRegistrationMetadata | null | undefined
): boolean {
  return (
    (current?.masumiRegistrationNetwork ?? null) !==
      (next?.masumiRegistrationNetwork ?? null) ||
    (current?.masumiInboxAgentId ?? null) !== (next?.masumiInboxAgentId ?? null) ||
    (current?.masumiAgentIdentifier ?? null) !==
      (next?.masumiAgentIdentifier ?? null) ||
    (current?.masumiRegistrationState ?? null) !==
      (next?.masumiRegistrationState ?? null)
  );
}

async function writeRegistrationMetadata(params: {
  actorId: bigint;
  persistRegistration: PersistRegistration;
  metadata: MasumiActorRegistrationMetadata | null | undefined;
}): Promise<void> {
  const payload = {
    agentDbId: params.actorId,
    masumiRegistrationNetwork: params.metadata?.masumiRegistrationNetwork,
    masumiInboxAgentId: params.metadata?.masumiInboxAgentId,
    masumiAgentIdentifier: params.metadata?.masumiAgentIdentifier,
    masumiRegistrationState: params.metadata?.masumiRegistrationState,
  };

  await params.persistRegistration(payload);
}

async function persistRegistrationMetadata(params: {
  actor: Agent;
  persistRegistration: PersistRegistration;
  metadata: MasumiActorRegistrationMetadata | null | undefined;
}): Promise<void> {
  if (
    !shouldPersistRegistrationMetadata(
      readActorRegistrationMetadata(params.actor),
      params.metadata
    )
  ) {
    return;
  }

  await writeRegistrationMetadata({
    actorId: params.actor.id,
    persistRegistration: params.persistRegistration,
    metadata: params.metadata,
  });
}

export function applyRegistrationMetadataToActor(
  actor: Agent,
  metadata: MasumiActorRegistrationMetadata | null | undefined
): Agent {
  return applyMasumiRegistrationMetadata(actor, metadata ?? undefined);
}

async function readApiJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function fetchBrowserRegistrationApi(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<unknown> {
  const result = await fetchBrowserRegistrationApiResponse(input, init);
  const payload = result.payload;

  if (!result.ok) {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
    ) {
      throw new Error(payload.error);
    }
    throw new Error(`Inbox-agent request failed (${result.status})`);
  }

  return payload;
}

async function fetchBrowserRegistrationApiResponse(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const payload = await readApiJson(response);

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function parseCreditsResponse(value: unknown): number {
  if (
    typeof value === 'object' &&
    value !== null &&
    'creditsRemaining' in value &&
    typeof value.creditsRemaining === 'number'
  ) {
    return value.creditsRemaining;
  }

  throw new Error('Masumi credits response is invalid');
}

function parseFindAgentsResponse(value: unknown): SerializedMasumiInboxAgentSearchResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('agents' in value) ||
    !Array.isArray((value as { agents?: unknown }).agents)
  ) {
    throw new Error('Masumi inbox-agent search response is invalid');
  }

  return value as SerializedMasumiInboxAgentSearchResponse;
}

function buildSerializedSubject(actor: Agent): SerializedMasumiActorRegistrationSubject {
  return {
    slug: actor.slug,
    displayName: actor.displayName ?? null,
    registration: serializeMasumiRegistrationMetadata(readActorRegistrationMetadata(actor)),
  };
}

function parseRegistrationResponse(
  value: unknown
): SerializedMasumiRegistrationResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('registration' in value)
  ) {
    throw new Error('Masumi inbox-agent response is invalid');
  }

  const response = value as Record<string, unknown>;
  const registration = response.registration;
  if (typeof registration !== 'object' || registration === null) {
    throw new Error('Masumi inbox-agent response is invalid');
  }

  return {
    registration: registration as MasumiRegistrationResult,
    metadata:
      typeof response.metadata === 'object' && response.metadata !== null
        ? (response.metadata as SerializedMasumiRegistrationResponse['metadata'])
        : null,
  };
}

export async function loadMasumiCredits(
  _session: AuthenticatedBrowserSession
): Promise<number> {
  const payload = await fetchBrowserRegistrationApi('/api/masumi/inbox-agent/credits');
  return parseCreditsResponse(payload);
}

export async function findMasumiInboxAgents(
  _session: AuthenticatedBrowserSession,
  params: {
    search: string;
    take?: number;
    page?: number;
  }
): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const url = new URL('/api/masumi/inbox-agent/find-agents', window.location.origin);
  const search = params.search.trim();
  if (search) {
    url.searchParams.set('search', search);
  }
  if (params.take !== undefined) {
    url.searchParams.set('take', String(params.take));
  }
  if (params.page !== undefined) {
    url.searchParams.set('page', String(params.page));
  }
  url.searchParams.set('mode', 'search');

  return parseFindAgentsResponse(await fetchBrowserRegistrationApi(url));
}

export async function listMasumiInboxAgents(
  _session: AuthenticatedBrowserSession,
  params: {
    take?: number;
    page?: number;
  } = {}
): Promise<SerializedMasumiInboxAgentSearchResponse> {
  const url = new URL('/api/masumi/inbox-agent/find-agents', window.location.origin);
  if (params.take !== undefined) {
    url.searchParams.set('take', String(params.take));
  }
  if (params.page !== undefined) {
    url.searchParams.set('page', String(params.page));
  }
  url.searchParams.set('mode', 'browse');

  return parseFindAgentsResponse(await fetchBrowserRegistrationApi(url));
}

export async function syncBrowserInboxAgentRegistration(params: {
  session: AuthenticatedBrowserSession;
  actor: Agent;
  persistRegistration: PersistRegistration;
}): Promise<{
  actor: Agent;
  registration: MasumiRegistrationResult;
}> {
  const response = await fetchBrowserRegistrationApiResponse(
    '/api/masumi/inbox-agent/sync',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSerializedSubject(params.actor)),
    }
  );
  let payload: SerializedMasumiRegistrationResponse;
  try {
    payload = parseRegistrationResponse(response.payload);
  } catch (parseError) {
    if (
      !response.ok &&
      typeof response.payload === 'object' &&
      response.payload !== null &&
      'error' in response.payload &&
      typeof response.payload.error === 'string'
    ) {
      const serverError = new Error(response.payload.error);
      (serverError as unknown as Record<string, unknown>).cause = parseError;
      throw serverError;
    }
    throw parseError;
  }
  const metadata = deserializeMasumiRegistrationMetadata(payload.metadata);

  if (metadata) {
    await persistRegistrationMetadata({
      actor: params.actor,
      persistRegistration: params.persistRegistration,
      metadata,
    });
  }

  return {
    actor: applyRegistrationMetadataToActor(params.actor, metadata),
    registration: payload.registration,
  };
}

export async function registerBrowserInboxAgent(params: {
  session: AuthenticatedBrowserSession;
  actor: Agent;
  persistRegistration: PersistRegistration;
}): Promise<{
  actor: Agent;
  registration: MasumiRegistrationResult;
}> {
  const currentMetadata = readActorRegistrationMetadata(params.actor);
  const requestedMetadata = createRegistrationRequestedMetadata({
    current: currentMetadata,
  });
  const requestedActor = applyRegistrationMetadataToActor(params.actor, requestedMetadata);

  await writeRegistrationMetadata({
    actorId: params.actor.id,
    persistRegistration: params.persistRegistration,
    metadata: requestedMetadata,
  });

  try {
    const response = await fetchBrowserRegistrationApiResponse(
      '/api/masumi/inbox-agent/register',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildSerializedSubject(params.actor)),
      }
    );
    let payload: SerializedMasumiRegistrationResponse;
    try {
      payload = parseRegistrationResponse(response.payload);
    } catch (parseError) {
      if (
        !response.ok &&
        typeof response.payload === 'object' &&
        response.payload !== null &&
        'error' in response.payload &&
        typeof response.payload.error === 'string'
      ) {
        const serverError = new Error(response.payload.error);
        (serverError as unknown as Record<string, unknown>).cause = parseError;
        throw serverError;
      }
      throw parseError;
    }
    const metadata = deserializeMasumiRegistrationMetadata(payload.metadata);
    const nextMetadata =
      metadata ??
      (payload.registration.status === 'failed'
        ? createRegistrationFailedMetadata({
            current: currentMetadata,
          })
        : currentMetadata);

    await persistRegistrationMetadata({
      actor: requestedActor,
      persistRegistration: params.persistRegistration,
      metadata: nextMetadata,
    });

    return {
      actor: applyRegistrationMetadataToActor(params.actor, nextMetadata),
      registration: payload.registration,
    };
  } catch (error) {
    await persistRegistrationMetadata({
      actor: requestedActor,
      persistRegistration: params.persistRegistration,
      metadata: createRegistrationFailedMetadata({
        current: currentMetadata,
      }),
    }).catch(() => undefined);
    throw error;
  }
}
