import { AsyncLocalStorage } from 'node:async_hooks';
import { tables, type DbConnection, type SubscriptionHandle } from '../../../webapp/src/module_bindings';
import {
  buildOwnActorIds,
  buildParticipantsByThreadId,
  findDefaultActorByEmail,
  resolveDirectCounterparty,
} from '../../../shared/inbox-state';
import { normalizeInboxSlug } from '../../../shared/inbox-slug';
import { prepareSpacetimeSubscriptionQuery } from '../../../shared/spacetime-subscription-limits';
import type {
  Agent,
  ThreadParticipant,
  Thread,
  ContactRequest,
  ContactAllowlistEntry,
  ThreadInvite,
  ThreadSecretEnvelope as VisibleThreadSecretEnvelopeRow,
  DeviceKeyBundle,
  Device,
  DeviceShareRequest,
  Account,
  Message,
  ChannelJoinRequest,
  ChannelMember,
  Channel,
  AccountChangeSignal,
  ThreadParticipantPreview,
  AgentKeyBundle,
} from '../../../webapp/src/module_bindings/types';
import { DbConnection as GeneratedDbConnection } from '../../../webapp/src/module_bindings';
import { connectivityError, userError } from './errors';
import { mergeRowsById } from './row-utils';

export type VisibleThreadParticipantRow = ThreadParticipantPreview & Partial<ThreadParticipant>;
export type VisibleThreadReadStateRow = VisibleThreadParticipantRow;

type ConnectionResult = {
  conn: DbConnection;
  identityHex: string;
};

export type BorrowedAuthenticatedConnection = {
  conn: DbConnection;
  host: string;
  databaseName: string;
  sessionToken: string;
  identityHex?: string;
};

export type PublishedAgentKeyPair = {
  encryption: {
    publicKey: string;
    keyVersion: number;
  };
  signing: {
    publicKey: string;
    keyVersion: number;
  };
};

const borrowedAuthenticatedConnection =
  new AsyncLocalStorage<BorrowedAuthenticatedConnection>();

export type ShellRows = {
  accounts: Account[];
  actors: Agent[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: Thread[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  allowlistEntries: ContactAllowlistEntry[];
  devices: Device[];
  deviceRequests: DeviceShareRequest[];
  deviceBundles: DeviceKeyBundle[];
  threadSignals: Thread[];
  channels: Channel[];
  channelMemberships: ChannelMember[];
  channelJoinRequests: ChannelJoinRequest[];
};

export type MessageRows = {
  actors: Agent[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  secretEnvelopes: VisibleThreadSecretEnvelopeRow[];
  threads: Thread[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  messages: Message[];
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
const limitSubscription = prepareSpacetimeSubscriptionQuery;
const DEFAULT_SPACETIME_OPERATION_TIMEOUT_MS = 10000;

function normalizeSpacetimeWebSocketUri(host: string): URL {
  const uri = new URL(host);
  if (uri.protocol === 'https:') {
    uri.protocol = 'wss:';
  } else if (uri.protocol === 'http:') {
    uri.protocol = 'ws:';
  }
  return uri;
}

// `visible_thread_read_states` is gone — read-state lives on `thread_participant`
// rows now. `visible_thread_secret_envelopes` was dropped too; clients fetch
// envelopes via the `listThreadSecretEnvelopes` procedure on demand.
const SHELL_VISIBLE_QUERIES = [
  limitSubscription(tables.visible_account_change_signal, 'visible_account_change_signal'),
  limitSubscription(tables.visible_accounts, 'visible_accounts'),
  limitSubscription(tables.visible_device_share_requests, 'visible_device_share_requests'),
  limitSubscription(tables.visible_device_key_bundles, 'visible_device_key_bundles'),
  limitSubscription(tables.visible_channels, 'visible_channels'),
  limitSubscription(tables.visible_channel_memberships, 'visible_channel_memberships'),
] as const;

const SHELL_TABLE_ACCESSORS = [
  'visible_account_change_signal',
  'visible_accounts',
  'visible_device_share_requests',
  'visible_device_key_bundles',
  'visible_channels',
  'visible_channel_memberships',
] as const satisfies ReadonlyArray<keyof DbConnection['db']>;

type ShellTableAccessor = (typeof SHELL_TABLE_ACCESSORS)[number];

function getTable<Row>(
  conn: DbConnection,
  accessorName: keyof DbConnection['db']
): TableLike<Row> {
  return conn.db[accessorName] as unknown as TableLike<Row>;
}

function attachShellRefreshListeners(
  conn: DbConnection,
  refresh: (accessorName: ShellTableAccessor) => void
): () => void {
  const cleanups: Array<() => void> = [];

  for (const accessorName of SHELL_TABLE_ACCESSORS) {
    const table = getTable<unknown>(conn, accessorName);
    const handleInsert = () => {
      refresh(accessorName);
    };
    const handleDelete = () => {
      refresh(accessorName);
    };
    const handleUpdate = () => {
      refresh(accessorName);
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

export async function withSpacetimeOperationTimeout<Result>(
  params: {
    label: string;
    timeoutMs?: number;
    code?: string;
  },
  run: () => PromiseLike<Result>
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: Result) => {
      if (settled) return;
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
        connectivityError(
          `Timed out waiting for SpacetimeDB ${params.label}. The connection may be stale; reconnect and retry once the inbox is live again.`,
          {
            code: params.code ?? 'SPACETIMEDB_OPERATION_TIMEOUT',
          }
        )
      );
    }, params.timeoutMs ?? DEFAULT_SPACETIME_OPERATION_TIMEOUT_MS);

    try {
      Promise.resolve(run()).then(settleResolve, settleReject);
    } catch (error) {
      settleReject(error);
    }
  });
}

export async function refreshAccountAuthLeaseIfBound(conn: DbConnection): Promise<void> {
  try {
    await withSpacetimeOperationTimeout(
      {
        label: 'account auth lease refresh',
        code: 'SPACETIMEDB_AUTH_LEASE_REFRESH_TIMEOUT',
      },
      () => conn.reducers.refreshAccountAuthLease({})
    );
  } catch (error) {
    const message = reducerErrorMessage(error);
    if (
      message === 'Caller has no account for this identity' ||
      message === 'No inbox is bound to this identity'
    ) {
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
  const borrowed = borrowedAuthenticatedConnection.getStore();
  if (
    borrowed &&
    borrowed.host === params.host &&
    borrowed.databaseName === params.databaseName &&
    borrowed.sessionToken === params.sessionToken
  ) {
    await refreshAccountAuthLeaseIfBound(borrowed.conn);
    return {
      conn: borrowed.conn,
      identityHex: borrowed.identityHex ?? '',
    };
  }

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

    GeneratedDbConnection.builder()
      .withUri(normalizeSpacetimeWebSocketUri(params.host).toString())
      .withDatabaseName(params.databaseName)
      .withToken(params.sessionToken)
      .onConnect((conn, identity) => {
        void refreshAccountAuthLeaseIfBound(conn)
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

export async function withExistingAuthenticatedConnection<Result>(
  params: BorrowedAuthenticatedConnection,
  run: () => Promise<Result>
): Promise<Result> {
  return await borrowedAuthenticatedConnection.run(params, run);
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
        limitSubscription(tables.visible_accounts, 'visible_accounts'),
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
        // Thread lists are procedure-backed; this tiny row invalidates cached
        // message/thread snapshots without subscribing to non-paginated views.
        limitSubscription(tables.visible_account_change_signal, 'visible_account_change_signal'),
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
        limitSubscription(tables.visible_accounts, 'visible_accounts'),
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
        limitSubscription(tables.visible_accounts, 'visible_accounts'),
        limitSubscription(tables.visible_device_share_requests, 'visible_device_share_requests'),
        limitSubscription(tables.visible_device_key_bundles, 'visible_device_key_bundles'),
      ]);
  });
}

export async function subscribeShellTables(
  conn: DbConnection,
  handlers?: {
    onUpdate?: (accessorName?: ShellTableAccessor) => void;
    onError?: (message: string) => void;
  }
): Promise<{ unsubscribe: () => void }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const detachListeners = attachShellRefreshListeners(conn, accessorName => {
      handlers?.onUpdate?.(accessorName);
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

export async function readAllOwnedAgents(conn: DbConnection): Promise<Agent[]> {
  const rows: Agent[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedAgentsPage({ afterId, limit: 250 });
    rows.push(...page.agents);
    if (!page.nextAfterId) {
      return rows;
    }
    afterId = page.nextAfterId;
  }
}

export async function readAgentCurrentKeyBundle(
  conn: DbConnection,
  actor: Agent
): Promise<AgentKeyBundle | null> {
  const bundles = await conn.procedures.lookupAgentKeyBundles({
    requests: [
      {
        agentDbId: actor.id,
        keyBundleVersion: actor.currentKeyBundleVersion,
      },
    ],
  });
  return bundles[0] ?? null;
}

export function publishedAgentKeyPairFromBundle(
  bundle: AgentKeyBundle
): PublishedAgentKeyPair {
  return {
    encryption: {
      publicKey: bundle.encryptionPublicKey,
      keyVersion: bundle.keyBundleVersion,
    },
    signing: {
      publicKey: bundle.signingPublicKey,
      keyVersion: bundle.keyBundleVersion,
    },
  };
}

export async function readPublishedAgentKeyPair(
  conn: DbConnection,
  actor: Agent
): Promise<PublishedAgentKeyPair | null> {
  const bundle = await readAgentCurrentKeyBundle(conn, actor);
  return bundle ? publishedAgentKeyPairFromBundle(bundle) : null;
}

export function publishedAgentKeyPairMatches(
  published: PublishedAgentKeyPair,
  expected: PublishedAgentKeyPair
): boolean {
  return (
    published.encryption.publicKey === expected.encryption.publicKey &&
    published.encryption.keyVersion === expected.encryption.keyVersion &&
    published.signing.publicKey === expected.signing.publicKey &&
    published.signing.keyVersion === expected.signing.keyVersion
  );
}

export async function readAllOwnedDevices(conn: DbConnection): Promise<Device[]> {
  const rows: Device[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listOwnedDevices({ afterId, limit: 100 });
    rows.push(...page);
    if (page.length < 100) {
      return rows;
    }
    afterId = page.at(-1)?.id;
    if (afterId === undefined) {
      return rows;
    }
  }
}

export async function readAllContactAllowlistEntries(
  conn: DbConnection
): Promise<ContactAllowlistEntry[]> {
  const rows: ContactAllowlistEntry[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listContactAllowlistEntries({
      afterId,
      limit: 250,
    });
    rows.push(...page);
    if (page.length < 250) {
      return rows;
    }
    afterId = page.at(-1)?.id;
    if (afterId === undefined) {
      return rows;
    }
  }
}

export async function readPendingContactRequests(conn: DbConnection): Promise<ContactRequest[]> {
  const rows: ContactRequest[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingContactRequestsPage({
      afterSortKey,
      limit: 250,
    });
    rows.push(...page.contactRequests);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

export async function readPendingThreadInvites(conn: DbConnection): Promise<ThreadInvite[]> {
  const rows: ThreadInvite[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingThreadInvitesPage({
      afterSortKey,
      limit: 250,
    });
    rows.push(...page.threadInvites);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

export async function readPendingChannelJoinRequests(conn: DbConnection): Promise<ChannelJoinRequest[]> {
  const rows: ChannelJoinRequest[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listPendingChannelJoinRequestsPage({
      afterSortKey,
      limit: 25,
    });
    rows.push(...page.joinRequests);
    if (!page.nextAfterSortKey) {
      return rows;
    }
    afterSortKey = page.nextAfterSortKey;
  }
}

function pickThreadListActor(actors: Agent[], actorSlug?: string | null): Agent | null {
  const normalizedSlug = actorSlug ? normalizeInboxSlug(actorSlug) : null;
  if (normalizedSlug) {
    const exact = actors.find(actor => actor.slug === normalizedSlug);
    if (exact) {
      return exact;
    }
  }
  return actors.find(actor => actor.isDefault) ?? actors[0] ?? null;
}

export function readStatesFromVisibleThreadPage(page: {
  participantPreviews: VisibleThreadParticipantRow[];
}): VisibleThreadReadStateRow[] {
  return page.participantPreviews.filter(participant => participant.lastReadMessageId !== undefined);
}

export async function readVisibleThreadSnapshot(conn: DbConnection, agentDbId: bigint): Promise<{
  actors: Agent[];
  participants: VisibleThreadParticipantRow[];
  readStates: VisibleThreadReadStateRow[];
  threads: Thread[];
}> {
  const actors: Agent[] = [];
  const participants: VisibleThreadParticipantRow[] = [];
  const threads: Thread[] = [];
  let afterSortKey: string | undefined;
  for (;;) {
    const page = await conn.procedures.listVisibleThreads({
      agentDbId,
      afterSortKey,
      limit: 25,
    });
    actors.push(...page.actors);
    participants.push(...page.participantPreviews);
    threads.push(...page.threads);
    if (!page.nextAfterSortKey) {
      break;
    }
    afterSortKey = page.nextAfterSortKey;
  }
  const mergedParticipants = mergeRowsById(participants, []);
  return {
    actors: mergeRowsById(actors, []),
    participants: mergedParticipants,
    readStates: mergedParticipants.filter(participant => participant.agentDbId === agentDbId),
    threads: mergeRowsById(threads, []),
  };
}

export async function readAllThreadParticipants(conn: DbConnection, threadId: bigint): Promise<{
  actors: Agent[];
  participants: VisibleThreadParticipantRow[];
}> {
  const actors: Agent[] = [];
  const participants: VisibleThreadParticipantRow[] = [];
  let afterId: bigint | undefined;
  for (;;) {
    const page = await conn.procedures.listThreadParticipants({
      threadId,
      afterId,
      limit: 50,
    });
    actors.push(...page.actors);
    participants.push(...page.participants);
    if (!page.nextAfterId) {
      return {
        actors: mergeRowsById(actors, []),
        participants: mergeRowsById(participants, []),
      };
    }
    afterId = page.nextAfterId;
  }
}

type ShellProcedureCache = {
  signalKey: string;
  actorSlug: string | null;
  actors: Agent[];
  devices: Device[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  allowlistEntries: ContactAllowlistEntry[];
  channelJoinRequests: ChannelJoinRequest[];
  threadSnapshot: {
    actors: Agent[];
    participants: VisibleThreadParticipantRow[];
    readStates: VisibleThreadReadStateRow[];
    threads: Thread[];
  };
};

const shellProcedureCache = new WeakMap<DbConnection, ShellProcedureCache>();

function readAccountChangeSignal(conn: DbConnection): AccountChangeSignal | null {
  return (Array.from(conn.db.visible_account_change_signal.iter()) as AccountChangeSignal[])[0] ?? null;
}

function signalKey(signal: AccountChangeSignal | null): string {
  if (!signal) {
    return 'no-signal';
  }
  return [
    signal.ownedAgentsVersion,
    signal.ownedDevicesVersion,
    signal.contactRequestsVersion,
    signal.threadInvitesVersion,
    signal.contactAllowlistVersion,
    signal.channelJoinRequestsVersion,
    signal.threadListVersion,
  ]
    .map(value => value.toString())
    .join(':');
}

async function readShellProcedureSlices(
  conn: DbConnection,
  params?: { actorSlug?: string | null; changedAccessor?: ShellTableAccessor }
): Promise<ShellProcedureCache> {
  const signal = readAccountChangeSignal(conn);
  const key = signalKey(signal);
  const normalizedActorSlug = params?.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
  const cached = shellProcedureCache.get(conn);
  if (
    params?.changedAccessor &&
    params.changedAccessor !== 'visible_account_change_signal' &&
    cached &&
    cached.actorSlug === normalizedActorSlug &&
    cached.actors.length > 0
  ) {
    return cached;
  }
  if (
    cached &&
    cached.signalKey === key &&
    cached.actorSlug === normalizedActorSlug &&
    cached.actors.length > 0
  ) {
    return cached;
  }
  const previousParts = cached?.signalKey.split(':') ?? [];
  const currentParts = signal
    ? [
        signal.ownedAgentsVersion,
        signal.ownedDevicesVersion,
        signal.contactRequestsVersion,
        signal.threadInvitesVersion,
        signal.contactAllowlistVersion,
        signal.channelJoinRequestsVersion,
        signal.threadListVersion,
      ].map(value => value.toString())
    : [];
  const sameVersion = (index: number) =>
    cached !== undefined &&
    signal !== null &&
    previousParts[index] !== undefined &&
    previousParts[index] === currentParts[index];

  const canReuseActors = sameVersion(0) && cached !== undefined && cached.actors.length > 0;
  const actors = canReuseActors ? cached.actors : await readAllOwnedAgents(conn);
  const actor = pickThreadListActor(actors, normalizedActorSlug);
  const [
    devices,
    contactRequests,
    threadInvites,
    allowlistEntries,
    channelJoinRequests,
    threadSnapshot,
  ] = await Promise.all([
    sameVersion(1) && cached
      ? Promise.resolve(cached.devices)
      : readAllOwnedDevices(conn),
    sameVersion(2) && cached
      ? Promise.resolve(cached.contactRequests)
      : readPendingContactRequests(conn),
    sameVersion(3) && cached
      ? Promise.resolve(cached.threadInvites)
      : readPendingThreadInvites(conn),
    sameVersion(4) && cached
      ? Promise.resolve(cached.allowlistEntries)
      : readAllContactAllowlistEntries(conn),
    sameVersion(5) && cached
      ? Promise.resolve(cached.channelJoinRequests)
      : readPendingChannelJoinRequests(conn),
    sameVersion(6) && cached && cached.actorSlug === normalizedActorSlug && canReuseActors
      ? Promise.resolve(cached.threadSnapshot)
      : actor
        ? readVisibleThreadSnapshot(conn, actor.id)
        : Promise.resolve({ actors: [], participants: [], readStates: [], threads: [] }),
  ]);

  const next: ShellProcedureCache = {
    signalKey: key,
    actorSlug: normalizedActorSlug,
    actors,
    devices,
    contactRequests,
    threadInvites,
    allowlistEntries,
    channelJoinRequests,
    threadSnapshot,
  };
  shellProcedureCache.set(conn, next);
  return next;
}

export async function readAccounts(conn: DbConnection): Promise<{
  accounts: Account[];
  actors: Agent[];
}> {
  const actors = await readAllOwnedAgents(conn);
  return {
    accounts: Array.from(conn.db.visible_accounts.iter()) as Account[],
    actors,
  };
}

export async function readMessageRows(
  conn: DbConnection,
  params?: { actorSlug?: string | null }
): Promise<MessageRows> {
  const normalizedActorSlug = params?.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
  const requestedActor = normalizedActorSlug
    ? await conn.procedures.readOwnedAgent({ slug: normalizedActorSlug })
    : null;
  const ownedActors = requestedActor ? [requestedActor] : await readAllOwnedAgents(conn);
  const threadActor = requestedActor ?? pickThreadListActor(ownedActors, params?.actorSlug);
  const [threadSnapshot, contactRequests, threadInvites] = await Promise.all([
    threadActor
      ? readVisibleThreadSnapshot(conn, threadActor.id)
      : Promise.resolve({ actors: [], participants: [], readStates: [], threads: [] }),
    readPendingContactRequests(conn),
    readPendingThreadInvites(conn),
  ]);
  return {
    actors: mergeRowsById(threadSnapshot.actors, ownedActors),
    participants: threadSnapshot.participants,
    readStates: threadSnapshot.readStates,
    // Envelopes are no longer in the global subscription. Callers that need
    // them fetch via `listThreadSecretEnvelopes` (rotation check) or
    // `listThreadMessages` page responses (display / decrypt).
    secretEnvelopes: [],
    threads: threadSnapshot.threads,
    contactRequests,
    threadInvites,
    messages: [],
  };
}

export async function readOwnedAgentRows(
  conn: DbConnection,
  params?: {
    email?: string;
    actorSlug?: string;
  }
): Promise<Agent[]> {
  const normalizedSlug =
    params?.actorSlug === undefined ? undefined : normalizeInboxSlug(params.actorSlug);
  if (params?.actorSlug !== undefined && !normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  const requestedAgent = normalizedSlug
    ? await conn.procedures.readOwnedAgent({ slug: normalizedSlug })
    : null;
  const requestedActors = requestedAgent
    ? [requestedAgent]
    : normalizedSlug
      ? []
      : await readAllOwnedAgents(conn);
  const actors = mergeRowsById(requestedActors, []);
  if (!params?.email) {
    return actors;
  }
  return actors.filter(actor => actor.email === params.email);
}

export async function readOwnedAgentRow(
  conn: DbConnection,
  params?: {
    email?: string;
    actorSlug?: string;
  }
): Promise<Agent | null> {
  const normalizedSlug =
    params?.actorSlug === undefined ? undefined : normalizeInboxSlug(params.actorSlug);
  if (params?.actorSlug !== undefined && !normalizedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }

  if (!normalizedSlug) {
    return null;
  }
  const actor = await conn.procedures.readOwnedAgent({ slug: normalizedSlug });
  if (!actor) {
    return null;
  }
  if (params?.email && actor.email !== params.email) {
    return null;
  }
  return actor;
}

async function readMessageRowsWithExactOwnedActor(
  conn: DbConnection,
  params?: {
    email?: string;
    actorSlug?: string;
  }
): Promise<MessageRows> {
  const rows = await readMessageRows(conn, { actorSlug: params?.actorSlug });
  const exactActors = await readOwnedAgentRows(conn, params);
  if (exactActors.length === 0) {
    return rows;
  }
  return {
    ...rows,
    actors: mergeRowsById(rows.actors, exactActors),
  };
}

export async function readSubscribedMessageRows(
  conn: DbConnection,
  params?: {
    email?: string;
    actorSlug?: string;
    threadId?: bigint | null;
    counterpartySlug?: string | null;
    messagePageSize?: bigint;
  }
): Promise<MessageRows> {
  const rows = await readMessageRowsWithExactOwnedActor(conn, params);
  const requestedSlug = params?.actorSlug ? normalizeInboxSlug(params.actorSlug) : null;
  if (params?.actorSlug && !requestedSlug) {
    throw userError('Agent slug is invalid.', {
      code: 'INVALID_SLUG',
    });
  }
  const exactRequestedActor =
    requestedSlug && params?.email
      ? rows.actors.find(row => row.email === params.email && row.slug === requestedSlug) ?? null
      : null;
  const defaultActor = params?.email
    ? exactRequestedActor ?? findDefaultActorByEmail(rows.actors, params.email)
    : rows.actors.find(actor => actor.isDefault) ?? rows.actors[0];
  if (!defaultActor) {
    return rows;
  }

  const actor =
    exactRequestedActor ??
    (requestedSlug === null
      ? defaultActor
      : rows.actors.find(
          row => row.accountId === defaultActor.accountId && row.slug === requestedSlug
        ));
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
    if (threadPage) {
      scopedRows = {
        ...rows,
        actors: mergeRowsById(rows.actors, threadPage.actors),
        participants: mergeRowsById(rows.participants, threadPage.participantPreviews),
        readStates: mergeRowsById(
          rows.readStates,
          threadPage.participantPreviews.filter(participant => participant.agentDbId === actor.id)
        ),
        threads: mergeRowsById(rows.threads, threadPage.threads),
      };
    }
  }
  const actorsById = new Map(scopedRows.actors.map(row => [row.id, row] as const));
  const threadsById = new Map(scopedRows.threads.map(row => [row.id, row] as const));
  const activeParticipants = scopedRows.participants.filter(row => row.active);
  const activeParticipantsByThreadId = buildParticipantsByThreadId(activeParticipants);
  const ownActorIds = buildOwnActorIds(scopedRows.actors, actor.accountId);
  const pagedMessages: Message[] = [];
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
      beforeMessageId: undefined,
      limit: Number(params?.messagePageSize ?? 5n),
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
    email?: string;
    actorSlug?: string;
    threadId?: bigint | null;
    counterpartySlug?: string | null;
    messagePageSize?: bigint;
  }
): Promise<MessageRows> {
  await ensureMessageTablesSubscribed(conn);
  return await readSubscribedMessageRows(conn, params);
}

export async function readLatestMetadataRows(
  conn: DbConnection,
  params?: {
    email?: string;
    actorSlug?: string;
  }
): Promise<MessageRows> {
  await ensureMessageTablesSubscribed(conn);
  return await readMessageRowsWithExactOwnedActor(conn, params);
}

export async function readContactRows(conn: DbConnection): Promise<{
  actors: Agent[];
  contactRequests: ContactRequest[];
  threadInvites: ThreadInvite[];
  allowlistEntries: ContactAllowlistEntry[];
}> {
  const [actors, contactRequests, threadInvites, allowlistEntries] = await Promise.all([
    readAllOwnedAgents(conn),
    readPendingContactRequests(conn),
    readPendingThreadInvites(conn),
    readAllContactAllowlistEntries(conn),
  ]);
  return {
    actors,
    contactRequests,
    threadInvites,
    allowlistEntries,
  };
}

export async function readDeviceRows(conn: DbConnection): Promise<{
  actors: Agent[];
  devices: Device[];
  requests: DeviceShareRequest[];
  bundles: DeviceKeyBundle[];
}> {
  const [actors, devices] = await Promise.all([
    readAllOwnedAgents(conn),
    readAllOwnedDevices(conn),
  ]);
  return {
    actors,
    devices,
    requests: Array.from(
      conn.db.visible_device_share_requests.iter()
    ) as DeviceShareRequest[],
    bundles: Array.from(
      conn.db.visible_device_key_bundles.iter()
    ) as DeviceKeyBundle[],
  };
}

export async function readShellRows(
  conn: DbConnection,
  params?: { actorSlug?: string | null; changedAccessor?: ShellTableAccessor }
): Promise<ShellRows> {
  const slices = await readShellProcedureSlices(conn, params);
  const accounts = Array.from(conn.db.visible_accounts.iter()) as Account[];

  return {
    accounts,
    actors: mergeRowsById(slices.threadSnapshot.actors, slices.actors),
    participants: slices.threadSnapshot.participants,
    readStates: slices.threadSnapshot.readStates,
    // Envelopes are no longer subscribed globally; consumers fetch them
    // per-thread via `listThreadSecretEnvelopes` or via `listThreadMessages`
    // page responses on demand.
    secretEnvelopes: [],
    threads: slices.threadSnapshot.threads,
    threadSignals: slices.threadSnapshot.threads,
    contactRequests: slices.contactRequests,
    threadInvites: slices.threadInvites,
    allowlistEntries: slices.allowlistEntries,
    devices: slices.devices,
    deviceRequests: Array.from(
      conn.db.visible_device_share_requests.iter()
    ) as DeviceShareRequest[],
    deviceBundles: Array.from(
      conn.db.visible_device_key_bundles.iter()
    ) as DeviceKeyBundle[],
    channels: Array.from(conn.db.visible_channels.iter()) as Channel[],
    channelMemberships: Array.from(
      conn.db.visible_channel_memberships.iter()
    ) as ChannelMember[],
    channelJoinRequests: slices.channelJoinRequests,
  };
}

export async function waitForBootstrapRows(params: {
  conn: DbConnection;
  email: string;
  encryptionPublicKey: string;
  encryptionKeyVersion: number;
  signingPublicKey: string;
  signingKeyVersion: number;
  deviceId?: string;
  timeoutMs?: number;
}): Promise<{
  inbox: Account;
  actor: Agent;
}> {
  const timeoutAt = Date.now() + (params.timeoutMs ?? 10000);
  const expectedKeyPair: PublishedAgentKeyPair = {
    encryption: {
      publicKey: params.encryptionPublicKey,
      keyVersion: params.encryptionKeyVersion,
    },
    signing: {
      publicKey: params.signingPublicKey,
      keyVersion: params.signingKeyVersion,
    },
  };

  while (Date.now() < timeoutAt) {
    const { accounts, actors } = await readAccounts(params.conn);
    const { devices } = await readDeviceRows(params.conn);
    const inbox = accounts.find(row => row.email === params.email);
    const actor = actors.find(row => {
      return row.email === params.email && row.isDefault;
    });
    const publishedKeyPair = actor
      ? await readPublishedAgentKeyPair(params.conn, actor)
      : null;
    const deviceReady =
      !params.deviceId ||
      devices.some(device => {
        return device.deviceId === params.deviceId && inbox && device.accountId === inbox.id;
      });

    if (
      inbox &&
      actor &&
      publishedKeyPair &&
      publishedAgentKeyPairMatches(publishedKeyPair, expectedKeyPair) &&
      deviceReady
    ) {
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
  const borrowed = borrowedAuthenticatedConnection.getStore();
  if (borrowed?.conn === conn) {
    return;
  }

  releaseMessageTablesSubscription(conn);
  conn.disconnect();
}
