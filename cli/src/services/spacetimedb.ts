import { tables, type DbConnection, type SubscriptionHandle } from '../../../webapp/src/module_bindings';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  resolveDirectCounterparty,
} from '../../../shared/inbox-state';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import { limitSpacetimeSubscriptionQuery } from '../../../shared/spacetime-subscription-limits';
import type {
  VisibleAgentRow,
  VisibleThreadParticipantRow,
  VisibleThreadReadStateRow,
  VisibleThreadRow,
  VisibleContactRequestRow,
  VisibleContactAllowlistEntryRow,
  VisibleThreadInviteRow,
  VisibleThreadSecretEnvelopeRow,
  VisibleDeviceKeyBundleRow,
  VisibleDeviceRow,
  VisibleDeviceShareRequestRow,
  VisibleInboxRow,
  VisibleMessageRow,
  VisibleChannelJoinRequestRow,
  VisibleChannelMembershipRow,
  VisibleChannelRow,
} from '../../../webapp/src/module_bindings/types';
import { DbConnection as GeneratedDbConnection } from '../../../webapp/src/module_bindings';
import { connectivityError, userError } from './errors';
import { mergeRowsById } from './row-utils';
import {
  hasCompletedProfileMigration,
  markProfileMigrationComplete,
} from './config-store';

type ConnectionResult = {
  conn: DbConnection;
  identityHex: string;
};

export type ShellRows = {
  inboxes: VisibleInboxRow[];
  actors: VisibleAgentRow[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: VisibleThreadRow[];
  contactRequests: VisibleContactRequestRow[];
  threadInvites: VisibleThreadInviteRow[];
  allowlistEntries: VisibleContactAllowlistEntryRow[];
  devices: VisibleDeviceRow[];
  deviceRequests: VisibleDeviceShareRequestRow[];
  deviceBundles: VisibleDeviceKeyBundleRow[];
  threadSignals: VisibleThreadRow[];
  channels: VisibleChannelRow[];
  channelMemberships: VisibleChannelMembershipRow[];
  channelJoinRequests: VisibleChannelJoinRequestRow[];
};

type TableLike<Row> = {
  iter(): Iterable<Row>;
  onInsert(callback: (ctx: unknown, row: Row) => void): void;
  removeOnInsert(callback: (ctx: unknown, row: Row) => void): void;
  onDelete(callback: (ctx: unknown, row: Row) => void): void;
  removeOnDelete(callback: (ctx: unknown, row: Row) => void): void;
  onUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
};

const messageTableSubscriptions = new WeakMap<DbConnection, Promise<SubscriptionHandle>>();
const limitSubscription = limitSpacetimeSubscriptionQuery;
const REPAIR_OWN_SENDER_READ_STATES_MIGRATION = 'repair-own-sender-read-states-v1';

function normalizeSpacetimeWebSocketUri(host: string): URL {
  const uri = new URL(host);
  if (uri.protocol === 'https:') {
    uri.protocol = 'wss:';
  } else if (uri.protocol === 'http:') {
    uri.protocol = 'ws:';
  }
  return uri;
}

const SHELL_VISIBLE_QUERIES = [
  limitSubscription(tables.visibleInboxes, 'visibleInboxes'),
  limitSubscription(tables.visibleAgents, 'visibleAgents'),
  limitSubscription(tables.visibleThreadParticipants, 'visibleThreadParticipants'),
  limitSubscription(tables.visibleThreadReadStates, 'visibleThreadReadStates'),
  limitSubscription(tables.visibleThreadSecretEnvelopes, 'visibleThreadSecretEnvelopes'),
  limitSubscription(tables.visibleThreads, 'visibleThreads'),
  limitSubscription(tables.visibleContactRequests, 'visibleContactRequests'),
  limitSubscription(tables.visibleThreadInvites, 'visibleThreadInvites'),
  limitSubscription(tables.visibleContactAllowlistEntries, 'visibleContactAllowlistEntries'),
  limitSubscription(tables.visibleDevices, 'visibleDevices'),
  limitSubscription(tables.visibleDeviceShareRequests, 'visibleDeviceShareRequests'),
  limitSubscription(tables.visibleDeviceKeyBundles, 'visibleDeviceKeyBundles'),
  limitSubscription(tables.visibleChannels, 'visibleChannels'),
  limitSubscription(tables.visibleChannelMemberships, 'visibleChannelMemberships'),
  limitSubscription(tables.visibleChannelJoinRequests, 'visibleChannelJoinRequests'),
] as const;

const SHELL_TABLE_ACCESSORS = [
  'visibleInboxes',
  'visibleAgents',
  'visibleThreadParticipants',
  'visibleThreadReadStates',
  'visibleThreadSecretEnvelopes',
  'visibleThreads',
  'visibleContactRequests',
  'visibleThreadInvites',
  'visibleContactAllowlistEntries',
  'visibleDevices',
  'visibleDeviceShareRequests',
  'visibleDeviceKeyBundles',
  'visibleChannels',
  'visibleChannelMemberships',
  'visibleChannelJoinRequests',
] as const satisfies ReadonlyArray<keyof DbConnection['db']>;

function getTable<Row>(
  conn: DbConnection,
  accessorName: keyof DbConnection['db']
): TableLike<Row> {
  return conn.db[accessorName] as unknown as TableLike<Row>;
}

function attachShellRefreshListeners(conn: DbConnection, refresh: () => void): () => void {
  const cleanups: Array<() => void> = [];

  for (const accessorName of SHELL_TABLE_ACCESSORS) {
    const table = getTable<unknown>(conn, accessorName);
    const handleInsert = () => {
      refresh();
    };
    const handleDelete = () => {
      refresh();
    };
    const handleUpdate = () => {
      refresh();
    };

    table.onInsert(handleInsert);
    table.onDelete(handleDelete);
    table.onUpdate?.(handleUpdate);

    cleanups.push(() => {
      table.removeOnInsert(handleInsert);
      table.removeOnDelete(handleDelete);
      table.removeOnUpdate?.(handleUpdate);
    });
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function readSubscriptionError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'event' in error &&
    (error as { event?: unknown }).event instanceof Error
  ) {
    return (error as { event: Error }).event.message;
  }

  return 'Live subscription failed.';
}

function fingerprintSessionToken(token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function reducerErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'event' in error &&
    (error as { event?: unknown }).event instanceof Error
  ) {
    return (error as { event: Error }).event.message;
  }

  return typeof error === 'string' && error.trim().length > 0 ? error : null;
}

function connectionErrorDetail(error: Error): string {
  return error.message.trim() || 'Unknown websocket connection error';
}

function formatConnectionTarget(params: { host: string; databaseName: string }): string {
  return `${params.host.replace(/\/+$/, '')}/${params.databaseName}`;
}

export async function refreshInboxAuthLeaseIfBound(conn: DbConnection): Promise<void> {
  try {
    await conn.reducers.refreshInboxAuthLease({});
  } catch (error) {
    if (reducerErrorMessage(error) === 'No inbox is bound to this identity') {
      return;
    }
    throw error;
  }
}

export async function connectAuthenticated(params: {
  host: string;
  databaseName: string;
  sessionToken: string;
  onDisconnect?: (error: Error | undefined) => void;
}): Promise<ConnectionResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: ConnectionResult) => {
      if (settled) {
        value.conn.disconnect();
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      settleReject(
        connectivityError('SpacetimeDB connection timeout.', {
          code: 'SPACETIMEDB_TIMEOUT',
        })
      );
    }, 10000);

    const uri = normalizeSpacetimeWebSocketUri(params.host);
    uri.searchParams.set('__session', fingerprintSessionToken(params.sessionToken));

    GeneratedDbConnection.builder()
      .withUri(uri.toString())
      .withDatabaseName(params.databaseName)
      .withToken(params.sessionToken)
      .onConnect((conn, identity) => {
        void refreshInboxAuthLeaseIfBound(conn)
          .then(() => {
            settleResolve({
              conn,
              identityHex: identity.toHexString(),
            });
          })
          .catch(error => {
            conn.disconnect();
            settleReject(
              connectivityError('Unable to refresh inbox authorization lease.', {
                code: 'SPACETIMEDB_AUTH_LEASE_REFRESH_FAILED',
                cause: error,
              })
            );
          });
      })
      .onConnectError((_ctx, error) => {
        settleReject(
          connectivityError(
            `Error connecting to SpacetimeDB at ${formatConnectionTarget(params)}: ${connectionErrorDetail(error)}`,
            {
              code: 'SPACETIMEDB_CONNECT_FAILED',
              cause: error,
            }
          )
        );
      })
      .onDisconnect((_ctx, error) => {
        if (!settled) {
          settleReject(
            connectivityError(
              `Disconnected from SpacetimeDB at ${formatConnectionTarget(params)}: ${
                error ? connectionErrorDetail(error) : 'connection closed'
              }`,
              {
                code: 'SPACETIMEDB_DISCONNECTED',
                cause: error,
              }
            )
          );
          return;
        }
        params.onDisconnect?.(error);
      })
      .build();
  });
}

export async function connectAnonymous(params: {
  host: string;
  databaseName: string;
}): Promise<ConnectionResult> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        connectivityError('SpacetimeDB connection timeout.', {
          code: 'SPACETIMEDB_TIMEOUT',
        })
      );
    }, 10000);

    GeneratedDbConnection.builder()
      .withUri(normalizeSpacetimeWebSocketUri(params.host).toString())
      .withDatabaseName(params.databaseName)
      .onConnect((conn, identity) => {
        clearTimeout(timeoutId);
        resolve({
          conn,
          identityHex: identity.toHexString(),
        });
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeoutId);
        reject(
          connectivityError(
            `Error connecting to SpacetimeDB at ${formatConnectionTarget(params)}: ${connectionErrorDetail(error)}`,
            {
              code: 'SPACETIMEDB_CONNECT_FAILED',
              cause: error,
            }
          )
        );
      })
      .build();
  });
}

export async function subscribeInboxTables(conn: DbConnection): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        resolve(subscription);
      })
      .onError(error => {
        reject(
          connectivityError('Live SpacetimeDB subscription failed.', {
            code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
            cause: error,
          })
        );
      })
      .subscribe([
        limitSubscription(tables.visibleInboxes, 'visibleInboxes'),
        limitSubscription(tables.visibleAgents, 'visibleAgents'),
        limitSubscription(tables.visibleDevices, 'visibleDevices'),
      ]);
  });
}

export async function subscribeMessageTables(conn: DbConnection): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        resolve(subscription);
      })
      .onError(error => {
        reject(
          connectivityError('Live SpacetimeDB message subscription failed.', {
            code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
            cause: error,
          })
        );
      })
      .subscribe([
        limitSubscription(tables.visibleAgents, 'visibleAgents'),
        limitSubscription(tables.visibleThreadParticipants, 'visibleThreadParticipants'),
        limitSubscription(tables.visibleThreadReadStates, 'visibleThreadReadStates'),
        limitSubscription(tables.visibleThreadSecretEnvelopes, 'visibleThreadSecretEnvelopes'),
        limitSubscription(tables.visibleThreads, 'visibleThreads'),
        limitSubscription(tables.visibleContactRequests, 'visibleContactRequests'),
        limitSubscription(tables.visibleThreadInvites, 'visibleThreadInvites'),
      ]);
  });
}

async function ensureMessageTablesSubscribed(conn: DbConnection): Promise<void> {
  let subscription = messageTableSubscriptions.get(conn);
  if (!subscription) {
    subscription = subscribeMessageTables(conn);
    messageTableSubscriptions.set(conn, subscription);
  }
  await subscription;
}

function releaseMessageTablesSubscription(conn: DbConnection): void {
  const subscription = messageTableSubscriptions.get(conn);
  if (!subscription) {
    return;
  }
  messageTableSubscriptions.delete(conn);
  void subscription
    .then(handle => {
      handle.unsubscribe();
    })
    .catch(() => {
      // The connection is already being torn down; failed cleanup is non-fatal.
    });
}

export async function subscribeContactTables(conn: DbConnection): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        resolve(subscription);
      })
      .onError(error => {
        reject(
          connectivityError('Live SpacetimeDB contact subscription failed.', {
            code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
            cause: error,
          })
        );
      })
      .subscribe([
        limitSubscription(tables.visibleAgents, 'visibleAgents'),
        limitSubscription(tables.visibleContactRequests, 'visibleContactRequests'),
        limitSubscription(tables.visibleThreadInvites, 'visibleThreadInvites'),
        limitSubscription(tables.visibleContactAllowlistEntries, 'visibleContactAllowlistEntries'),
      ]);
  });
}

export async function subscribeDeviceTables(conn: DbConnection): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        resolve(subscription);
      })
      .onError(error => {
        reject(
          connectivityError('Live SpacetimeDB device subscription failed.', {
            code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
            cause: error,
          })
        );
      })
      .subscribe([
        limitSubscription(tables.visibleAgents, 'visibleAgents'),
        limitSubscription(tables.visibleDevices, 'visibleDevices'),
        limitSubscription(tables.visibleDeviceShareRequests, 'visibleDeviceShareRequests'),
        limitSubscription(tables.visibleDeviceKeyBundles, 'visibleDeviceKeyBundles'),
      ]);
  });
}

export async function subscribeShellTables(
  conn: DbConnection,
  handlers?: {
    onUpdate?: () => void;
    onError?: (message: string) => void;
  }
): Promise<{ unsubscribe: () => void }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const detachListeners = attachShellRefreshListeners(conn, () => {
      handlers?.onUpdate?.();
    });
    const subscription = conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (!resolved) {
          resolved = true;
          resolve({
            unsubscribe: () => {
              detachListeners();
              subscription.unsubscribe();
            },
          });
        }
        handlers?.onUpdate?.();
      })
      .onError(error => {
        handlers?.onError?.(readSubscriptionError(error));
        if (!resolved) {
          detachListeners();
          reject(
            connectivityError('Live SpacetimeDB shell subscription failed.', {
              code: 'SPACETIMEDB_SUBSCRIPTION_FAILED',
              cause: error,
            })
          );
        }
      })
      .subscribe([...SHELL_VISIBLE_QUERIES]);
  });
}

export function readInboxRows(conn: DbConnection): {
  inboxes: VisibleInboxRow[];
  actors: VisibleAgentRow[];
} {
  return {
    inboxes: Array.from(conn.db.visibleInboxes.iter()) as VisibleInboxRow[],
    actors: Array.from(conn.db.visibleAgents.iter()) as VisibleAgentRow[],
  };
}

export function readMessageRows(conn: DbConnection): {
  actors: VisibleAgentRow[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: VisibleThreadRow[];
  contactRequests: VisibleContactRequestRow[];
  threadInvites: VisibleThreadInviteRow[];
  messages: VisibleMessageRow[];
} {
  return {
    actors: Array.from(conn.db.visibleAgents.iter()) as VisibleAgentRow[],
    participants: Array.from(
      conn.db.visibleThreadParticipants.iter()
    ) as VisibleThreadParticipantRow[],
    readStates: Array.from(conn.db.visibleThreadReadStates.iter()) as VisibleThreadReadStateRow[],
    secretEnvelopes: Array.from(
      conn.db.visibleThreadSecretEnvelopes.iter()
    ) as VisibleThreadSecretEnvelopeRow[],
    threads: Array.from(conn.db.visibleThreads.iter()) as VisibleThreadRow[],
    contactRequests: Array.from(
      conn.db.visibleContactRequests.iter()
    ) as VisibleContactRequestRow[],
    threadInvites: Array.from(
      conn.db.visibleThreadInvites.iter()
    ) as VisibleThreadInviteRow[],
    messages: [],
  };
}

export async function readOwnedAgentRows(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
  }
): Promise<VisibleAgentRow[]> {
  const normalizedSlug =
    params?.actorSlug === undefined ? undefined : normalizeInboxSlug(params.actorSlug);
  if (params?.actorSlug !== undefined && !normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const requestedActors = await conn.procedures.readOwnedAgent({
    agentSlug: normalizedSlug,
  });
  const defaultActors =
    normalizedSlug === undefined
      ? []
      : await conn.procedures.readOwnedAgent({
          agentSlug: undefined,
        });
  const actors = mergeRowsById(requestedActors, defaultActors);
  if (!params?.normalizedEmail) {
    return actors;
  }
  return actors.filter(actor => actor.normalizedEmail === params.normalizedEmail);
}

export async function readOwnedAgentRow(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
  }
): Promise<VisibleAgentRow | null> {
  const normalizedSlug =
    params?.actorSlug === undefined ? undefined : normalizeInboxSlug(params.actorSlug);
  if (params?.actorSlug !== undefined && !normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const actors = await conn.procedures.readOwnedAgent({
    agentSlug: normalizedSlug,
  });
  const filteredActors = params?.normalizedEmail
    ? actors.filter(actor => actor.normalizedEmail === params.normalizedEmail)
    : actors;
  return filteredActors[0] ?? null;
}

async function readMessageRowsWithExactOwnedActor(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
  }
): Promise<ReturnType<typeof readMessageRows>> {
  const rows = readMessageRows(conn);
  const exactActors = await readOwnedAgentRows(conn, params);
  if (exactActors.length === 0) {
    return rows;
  }
  return {
    ...rows,
    actors: mergeRowsById(rows.actors, exactActors),
  };
}

export async function repairOwnSenderReadStatesOnce(
  conn: DbConnection,
  params: {
    profileName: string;
    actorId: bigint;
  }
): Promise<boolean> {
  const migrationKey = `${REPAIR_OWN_SENDER_READ_STATES_MIGRATION}:${params.actorId.toString()}`;
  if (await hasCompletedProfileMigration(params.profileName, migrationKey)) {
    return false;
  }

  await conn.reducers.repairOwnSenderReadStates({
    agentDbId: params.actorId,
  });
  await markProfileMigrationComplete(params.profileName, migrationKey);
  return true;
}

export async function readSubscribedMessageRows(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
    threadId?: bigint | null;
    counterpartySlug?: string | null;
    messagePageSize?: bigint;
  }
): Promise<ReturnType<typeof readMessageRows>> {
  const rows = await readMessageRowsWithExactOwnedActor(conn, params);
  const defaultActor = params?.normalizedEmail
    ? findDefaultActorByEmail(rows.actors, params.normalizedEmail)
    : rows.actors.find(actor => actor.isDefault) ?? rows.actors[0];
  if (!defaultActor) {
    return rows;
  }

  const requestedSlug = params?.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
  if (params?.actorSlug && !requestedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }
  const actor =
    requestedSlug === null
      ? defaultActor
      : rows.actors.find(row => row.inboxId === defaultActor.inboxId && row.slug === requestedSlug);
  if (!actor) {
    throw userError(`No owned agent found for slug \`${requestedSlug ?? ''}\`.`, {
      code: 'OWNED_ACTOR_NOT_FOUND',
    });
  }
  const requestedCounterpartySlug = params?.counterpartySlug
    ? normalizeInboxSlug(params.counterpartySlug)
    : null;
  if (params?.counterpartySlug && !requestedCounterpartySlug) {
    throw userError('Counterparty slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }
  let scopedRows = rows;
  if (
    params?.threadId !== undefined &&
    params.threadId !== null &&
    !rows.threads.some(row => row.id === params.threadId)
  ) {
    const threadPage = await conn.procedures.readVisibleThread({
      agentDbId: actor.id,
      threadId: params.threadId,
    });
    scopedRows = {
      ...rows,
      actors: mergeRowsById(rows.actors, threadPage.actors),
      participants: mergeRowsById(rows.participants, threadPage.participants),
      readStates: mergeRowsById(rows.readStates, threadPage.readStates),
      threads: mergeRowsById(rows.threads, threadPage.threads),
    };
  }
  const actorsById = new Map(scopedRows.actors.map(row => [row.id, row] as const));
  const threadsById = new Map(scopedRows.threads.map(row => [row.id, row] as const));
  const activeParticipants = scopedRows.participants.filter(row => row.active);
  const activeParticipantsByThreadId = buildParticipantsByThreadId(activeParticipants);
  const ownActorIds = buildOwnActorIds(scopedRows.actors, actor.inboxId);
  const pagedMessages: VisibleMessageRow[] = [];
  let visibleSecretEnvelopes = scopedRows.secretEnvelopes;

  for (const thread of threadsById.values()) {
    if (params?.threadId !== undefined && params.threadId !== null && thread.id !== params.threadId) {
      continue;
    }
    const threadParticipants = activeParticipantsByThreadId.get(thread.id) ?? [];
    const actorParticipant = threadParticipants.find(row => row.agentDbId === actor.id);
    if (!actorParticipant) {
      continue;
    }
    if (requestedCounterpartySlug) {
      const counterparty = resolveDirectCounterparty({
        thread,
        participantsByThreadId: activeParticipantsByThreadId,
        actorsById,
        ownActorIds,
      });
      if (counterparty?.slug !== requestedCounterpartySlug) {
        continue;
      }
    }

    const page = await conn.procedures.listThreadMessages({
      agentDbId: actor.id,
      threadId: thread.id,
      beforeThreadSeq: undefined,
      limit: params?.messagePageSize ?? 5n,
    });
    pagedMessages.push(...page.messages);
    visibleSecretEnvelopes = mergeRowsById(visibleSecretEnvelopes, page.secretEnvelopes);
  }

  return {
    ...scopedRows,
    secretEnvelopes: visibleSecretEnvelopes,
    messages: pagedMessages,
  };
}

export async function readLatestMessageRows(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
    threadId?: bigint | null;
    counterpartySlug?: string | null;
    messagePageSize?: bigint;
  }
): Promise<ReturnType<typeof readMessageRows>> {
  await ensureMessageTablesSubscribed(conn);
  return await readSubscribedMessageRows(conn, params);
}

export async function readLatestMetadataRows(
  conn: DbConnection,
  params?: {
    normalizedEmail?: string;
    actorSlug?: string;
  }
): Promise<ReturnType<typeof readMessageRows>> {
  await ensureMessageTablesSubscribed(conn);
  return await readMessageRowsWithExactOwnedActor(conn, params);
}

export function readContactRows(conn: DbConnection): {
  actors: VisibleAgentRow[];
  contactRequests: VisibleContactRequestRow[];
  threadInvites: VisibleThreadInviteRow[];
  allowlistEntries: VisibleContactAllowlistEntryRow[];
} {
  return {
    actors: Array.from(conn.db.visibleAgents.iter()) as VisibleAgentRow[],
    contactRequests: Array.from(
      conn.db.visibleContactRequests.iter()
    ) as VisibleContactRequestRow[],
    threadInvites: Array.from(
      conn.db.visibleThreadInvites.iter()
    ) as VisibleThreadInviteRow[],
    allowlistEntries: Array.from(
      conn.db.visibleContactAllowlistEntries.iter()
    ) as VisibleContactAllowlistEntryRow[],
  };
}

export function readDeviceRows(conn: DbConnection): {
  actors: VisibleAgentRow[];
  devices: VisibleDeviceRow[];
  requests: VisibleDeviceShareRequestRow[];
  bundles: VisibleDeviceKeyBundleRow[];
} {
  return {
    actors: Array.from(conn.db.visibleAgents.iter()) as VisibleAgentRow[],
    devices: Array.from(conn.db.visibleDevices.iter()) as VisibleDeviceRow[],
    requests: Array.from(
      conn.db.visibleDeviceShareRequests.iter()
    ) as VisibleDeviceShareRequestRow[],
    bundles: Array.from(
      conn.db.visibleDeviceKeyBundles.iter()
    ) as VisibleDeviceKeyBundleRow[],
  };
}

export function readShellRows(conn: DbConnection): ShellRows {
  const inbox = readInboxRows(conn);
  const contact = readContactRows(conn);
  const device = readDeviceRows(conn);

  return {
    inboxes: inbox.inboxes,
    actors: inbox.actors,
    participants: Array.from(
      conn.db.visibleThreadParticipants.iter()
    ) as VisibleThreadParticipantRow[],
    readStates: Array.from(conn.db.visibleThreadReadStates.iter()) as VisibleThreadReadStateRow[],
    secretEnvelopes: Array.from(
      conn.db.visibleThreadSecretEnvelopes.iter()
    ) as VisibleThreadSecretEnvelopeRow[],
    threads: [],
    threadSignals: Array.from(conn.db.visibleThreads.iter()) as VisibleThreadRow[],
    contactRequests: contact.contactRequests,
    threadInvites: contact.threadInvites,
    allowlistEntries: contact.allowlistEntries,
    devices: device.devices,
    deviceRequests: device.requests,
    deviceBundles: device.bundles,
    channels: Array.from(conn.db.visibleChannels.iter()) as VisibleChannelRow[],
    channelMemberships: Array.from(
      conn.db.visibleChannelMemberships.iter()
    ) as VisibleChannelMembershipRow[],
    channelJoinRequests: Array.from(
      conn.db.visibleChannelJoinRequests.iter()
    ) as VisibleChannelJoinRequestRow[],
  };
}

export async function waitForBootstrapRows(params: {
  conn: DbConnection;
  normalizedEmail: string;
  encryptionPublicKey: string;
  encryptionKeyVersion: string;
  signingPublicKey: string;
  signingKeyVersion: string;
  deviceId?: string;
  timeoutMs?: number;
}): Promise<{
  inbox: VisibleInboxRow;
  actor: VisibleAgentRow;
}> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);

  while (Date.now() < timeoutAt) {
    const { inboxes, actors } = readInboxRows(params.conn);
    const { devices } = readDeviceRows(params.conn);
    const inbox = inboxes.find(row => row.normalizedEmail === params.normalizedEmail);
    const actor = actors.find(row => {
      return (
        row.normalizedEmail === params.normalizedEmail &&
        row.isDefault &&
        row.currentEncryptionPublicKey === params.encryptionPublicKey &&
        row.currentEncryptionKeyVersion === params.encryptionKeyVersion &&
        row.currentSigningPublicKey === params.signingPublicKey &&
        row.currentSigningKeyVersion === params.signingKeyVersion
      );
    });
    const deviceReady =
      !params.deviceId ||
      devices.some(device => {
        return device.deviceId === params.deviceId && inbox && device.inboxId === inbox.id;
      });

    if (inbox && actor && deviceReady) {
      return { inbox, actor };
    }

    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }

  throw connectivityError('Timed out waiting for inbox bootstrap state to sync.', {
    code: 'SPACETIMEDB_BOOTSTRAP_TIMEOUT',
  });
}

export function disconnectConnection(conn: DbConnection): void {
  releaseMessageTablesSubscription(conn);
  conn.disconnect();
}
