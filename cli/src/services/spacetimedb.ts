import { tables, type DbConnection, type SubscriptionHandle } from '../../../webapp/src/module_bindings';
import type {
  VisibleAgentRow,
  VisibleAgentKeyBundleRow,
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
  VisibleChannelMessageRow,
  VisibleChannelMembershipRow,
  VisibleChannelRow,
} from '../../../webapp/src/module_bindings/types';
import { DbConnection as GeneratedDbConnection } from '../../../webapp/src/module_bindings';
import { connectivityError } from './errors';

type ConnectionResult = {
  conn: DbConnection;
  identityHex: string;
};

export type ShellRows = {
  inboxes: VisibleInboxRow[];
  actors: VisibleAgentRow[];
  bundles: VisibleAgentKeyBundleRow[];
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
  messages: VisibleMessageRow[];
  channels: VisibleChannelRow[];
  channelMessages: VisibleChannelMessageRow[];
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

const SHELL_VISIBLE_QUERIES = [
  tables.visibleInboxes,
  tables.visibleAgents,
  tables.visibleAgentKeyBundles,
  tables.visibleThreadParticipants,
  tables.visibleThreadReadStates,
  tables.visibleThreadSecretEnvelopes,
  tables.visibleThreads,
  tables.visibleContactRequests,
  tables.visibleThreadInvites,
  tables.visibleContactAllowlistEntries,
  tables.visibleDevices,
  tables.visibleDeviceShareRequests,
  tables.visibleDeviceKeyBundles,
  tables.visibleMessages,
  tables.visibleChannels,
  tables.visibleChannelMessages,
  tables.visibleChannelMemberships,
  tables.visibleChannelJoinRequests,
] as const;

const SHELL_TABLE_ACCESSORS = [
  'visibleInboxes',
  'visibleAgents',
  'visibleAgentKeyBundles',
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
  'visibleMessages',
  'visibleChannels',
  'visibleChannelMessages',
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

async function refreshInboxAuthLeaseIfBound(conn: DbConnection): Promise<void> {
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
}): Promise<ConnectionResult> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        connectivityError('SpacetimeDB connection timeout.', {
          code: 'SPACETIMEDB_TIMEOUT',
        })
      );
    }, 10000);

    const uri = new URL(params.host);
    uri.searchParams.set('__session', fingerprintSessionToken(params.sessionToken));

    GeneratedDbConnection.builder()
      .withUri(uri.toString())
      .withDatabaseName(params.databaseName)
      .withToken(params.sessionToken)
      .onConnect((conn, identity) => {
        void refreshInboxAuthLeaseIfBound(conn)
          .then(() => {
            clearTimeout(timeoutId);
            resolve({
              conn,
              identityHex: identity.toHexString(),
            });
          })
          .catch(error => {
            clearTimeout(timeoutId);
            conn.disconnect();
            reject(
              connectivityError('Unable to refresh inbox authorization lease.', {
                code: 'SPACETIMEDB_AUTH_LEASE_REFRESH_FAILED',
                cause: error,
              })
            );
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
      .withUri(params.host)
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
      .subscribe([tables.visibleInboxes, tables.visibleAgents, tables.visibleDevices]);
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
        tables.visibleAgents,
        tables.visibleAgentKeyBundles,
        tables.visibleThreadParticipants,
        tables.visibleThreadReadStates,
        tables.visibleThreadSecretEnvelopes,
        tables.visibleThreads,
        tables.visibleContactRequests,
        tables.visibleThreadInvites,
        tables.visibleMessages,
      ]);
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
        tables.visibleAgents,
        tables.visibleContactRequests,
        tables.visibleThreadInvites,
        tables.visibleContactAllowlistEntries,
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
        tables.visibleAgents,
        tables.visibleDevices,
        tables.visibleDeviceShareRequests,
        tables.visibleDeviceKeyBundles,
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
  bundles: VisibleAgentKeyBundleRow[];
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
    bundles: Array.from(conn.db.visibleAgentKeyBundles.iter()) as VisibleAgentKeyBundleRow[],
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
    messages: Array.from(conn.db.visibleMessages.iter()) as VisibleMessageRow[],
  };
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
  const message = readMessageRows(conn);
  const contact = readContactRows(conn);
  const device = readDeviceRows(conn);

  return {
    inboxes: inbox.inboxes,
    actors: inbox.actors,
    bundles: message.bundles,
    participants: message.participants,
    readStates: message.readStates,
    secretEnvelopes: message.secretEnvelopes,
    threads: message.threads,
    contactRequests: message.contactRequests,
    threadInvites: message.threadInvites,
    allowlistEntries: contact.allowlistEntries,
    devices: device.devices,
    deviceRequests: device.requests,
    deviceBundles: device.bundles,
    messages: message.messages,
    channels: Array.from(conn.db.visibleChannels.iter()) as VisibleChannelRow[],
    channelMessages: Array.from(
      conn.db.visibleChannelMessages.iter()
    ) as VisibleChannelMessageRow[],
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
  conn.disconnect();
}
