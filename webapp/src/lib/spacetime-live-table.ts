import { useEffect, useState } from 'react';
import {
  evaluateBooleanExpr,
  getQueryWhereClause,
  toSql,
  type Query,
  type TypedTableDef,
} from 'spacetimedb';
import { DbConnection, tables } from '@/module_bindings';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import {
  describeInboxAuthLeaseRefreshError,
  ensureInboxAuthLease,
} from './inbox-auth-lease';
import { deferEffectStateUpdate } from './effect-state';
import {
  limitSpacetimeSubscriptionQuery,
  type SpacetimeSubscriptionTableName,
} from '../../../shared/spacetime-subscription-limits';

type LiveTableName = Extract<keyof typeof tables, SpacetimeSubscriptionTableName>;
type LiveTableQuery = Query<TypedTableDef>;

type TableLike<Row> = {
  iter(): Iterable<Row>;
  onInsert(callback: (ctx: unknown, row: Row) => void): void;
  removeOnInsert(callback: (ctx: unknown, row: Row) => void): void;
  onDelete(callback: (ctx: unknown, row: Row) => void): void;
  removeOnDelete(callback: (ctx: unknown, row: Row) => void): void;
  onUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
};

type LiveTableSnapshot<Row> = {
  rows: Row[];
  ready: boolean;
  error: string | null;
};

type SharedListener<Row> = (snapshot: LiveTableSnapshot<Row>) => void;

type SharedSubscription<Row> = {
  snapshot: LiveTableSnapshot<Row>;
  listeners: Set<SharedListener<Row>>;
  refCount: number;
  started: boolean;
  stopped: boolean;
  whereExpr: ReturnType<typeof getQueryWhereClause> | undefined;
  subscription: { unsubscribe: () => void } | null;
  removeListeners: (() => void) | null;
};

type UseLiveTableOptions = {
  enabled?: boolean;
};

const sharedSubscriptionsByConnection = new WeakMap<
  DbConnection,
  Map<string, SharedSubscription<unknown>>
>();

function getTable<Row>(connection: DbConnection, accessorName: LiveTableName): TableLike<Row> {
  return connection.db[accessorName] as unknown as TableLike<Row>;
}

function getSharedSubscriptions(connection: DbConnection): Map<string, SharedSubscription<unknown>> {
  const existing = sharedSubscriptionsByConnection.get(connection);
  if (existing) {
    return existing;
  }

  const created = new Map<string, SharedSubscription<unknown>>();
  sharedSubscriptionsByConnection.set(connection, created);
  return created;
}

function buildSharedSubscriptionKey(
  kind: 'auth' | 'public',
  accessorName: LiveTableName,
  tableQuery: LiveTableQuery
): string {
  return `${kind}:${String(accessorName)}:${toSql(tableQuery)}`;
}

function notifySharedSubscription<Row>(shared: SharedSubscription<Row>): void {
  const snapshot = shared.snapshot;
  for (const listener of shared.listeners) {
    listener(snapshot);
  }
}

function refreshSharedRows<Row>(
  connection: DbConnection,
  accessorName: LiveTableName,
  shared: SharedSubscription<Row>
): void {
  const table = getTable<Row>(connection, accessorName);
  shared.snapshot = {
    ...shared.snapshot,
    rows: Array.from(table.iter()).filter(row =>
      shared.whereExpr
        ? evaluateBooleanExpr(shared.whereExpr, row as Record<string, unknown>)
        : true
    ),
  };
  notifySharedSubscription(shared);
}

function readSubscriptionError(error: unknown): string {
  const errorMessage =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'event' in error &&
          (error as { event?: unknown }).event instanceof Error
        ? (error as { event: Error }).event.message
        : null;

  if (
    errorMessage &&
    (errorMessage.includes('BinaryReader') ||
      errorMessage.includes('Tried to read ') ||
      errorMessage.includes('relative offset'))
  ) {
    return 'SpacetimeDB schema mismatch between published module and generated bindings. Re-publish database module, then regenerate bindings.';
  }

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

  return 'Live subscription failed';
}

function startSharedSubscription<Row>(params: {
  connection: DbConnection;
  accessorName: LiveTableName;
  tableQuery: LiveTableQuery;
  requiresInboxAuthLease: boolean;
  shared: SharedSubscription<Row>;
}): void {
  const { connection, accessorName, tableQuery, requiresInboxAuthLease, shared } = params;
  if (shared.started) {
    return;
  }

  shared.started = true;

  const begin = requiresInboxAuthLease ? ensureInboxAuthLease(connection) : Promise.resolve();
  void begin
    .then(() => {
      if (shared.stopped) {
        return;
      }

      const table = getTable<Row>(connection, accessorName);
      const refresh = () => {
        refreshSharedRows(connection, accessorName, shared);
      };

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
      shared.removeListeners = () => {
        table.removeOnInsert(handleInsert);
        table.removeOnDelete(handleDelete);
        table.removeOnUpdate?.(handleUpdate);
      };

      refresh();

      shared.subscription = connection
        .subscriptionBuilder()
        .onApplied(() => {
          refreshSharedRows(connection, accessorName, shared);
          shared.snapshot = {
            ...shared.snapshot,
            ready: true,
            error: null,
          };
          notifySharedSubscription(shared);
        })
        .onError(subscriptionError => {
          shared.snapshot = {
            ...shared.snapshot,
            ready: false,
            error: readSubscriptionError(subscriptionError),
          };
          notifySharedSubscription(shared);
        })
        .subscribe([
          limitSpacetimeSubscriptionQuery(
            toSql(tableQuery),
            accessorName
          ),
        ]);
    })
    .catch(error => {
      if (shared.stopped) {
        return;
      }

      shared.snapshot = {
        ...shared.snapshot,
        ready: false,
        error: requiresInboxAuthLease
          ? describeInboxAuthLeaseRefreshError(error)
          : readSubscriptionError(error),
      };
      notifySharedSubscription(shared);
    });
}

function retainSharedSubscription<Row>(params: {
  connection: DbConnection;
  accessorName: LiveTableName;
  tableQuery: LiveTableQuery;
  requiresInboxAuthLease: boolean;
  kind: 'auth' | 'public';
}): {
  key: string;
  shared: SharedSubscription<Row>;
} {
  const { connection, accessorName, tableQuery, requiresInboxAuthLease, kind } = params;
  const key = buildSharedSubscriptionKey(kind, accessorName, tableQuery);
  const sharedSubscriptions = getSharedSubscriptions(connection);
  const existing = sharedSubscriptions.get(key) as SharedSubscription<Row> | undefined;
  if (existing) {
    existing.refCount += 1;
    return { key, shared: existing };
  }

  const created: SharedSubscription<Row> = {
    snapshot: {
      rows: [],
      ready: false,
      error: null,
    },
    listeners: new Set<SharedListener<Row>>(),
    refCount: 1,
    started: false,
    stopped: false,
    whereExpr: getQueryWhereClause(tableQuery),
    subscription: null,
    removeListeners: null,
  };
  sharedSubscriptions.set(key, created as SharedSubscription<unknown>);
  startSharedSubscription({
    connection,
    accessorName,
    tableQuery,
    requiresInboxAuthLease,
    shared: created,
  });
  return { key, shared: created };
}

function releaseSharedSubscription<Row>(
  connection: DbConnection,
  key: string,
  shared: SharedSubscription<Row>
): void {
  shared.refCount -= 1;
  if (shared.refCount > 0) {
    return;
  }

  shared.stopped = true;
  shared.subscription?.unsubscribe();
  shared.removeListeners?.();
  const sharedSubscriptions = getSharedSubscriptions(connection);
  sharedSubscriptions.delete(key);
  if (sharedSubscriptions.size === 0) {
    sharedSubscriptionsByConnection.delete(connection);
  }
}

function useSharedLiveTable<Row>(
  tableQuery: LiveTableQuery,
  accessorName: LiveTableName,
  kind: 'auth' | 'public',
  options: UseLiveTableOptions = {}
): [Row[], boolean, string | null] {
  const connectionState = useSpacetimeDB();
  const [rows, setRows] = useState<Row[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled || !isActive || !connection) {
      return deferEffectStateUpdate(() => {
        setRows([]);
        setReady(false);
        setError(null);
      });
    }

    let cancelled = false;

    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setReady(false);
        setError(null);
      }
    });

    const { key, shared } = retainSharedSubscription<Row>({
      connection,
      accessorName,
      tableQuery,
      requiresInboxAuthLease: kind === 'auth',
      kind,
    });

    const applySnapshot = (snapshot: LiveTableSnapshot<Row>) => {
      if (cancelled) {
        return;
      }

      setRows(snapshot.rows);
      setReady(snapshot.ready);
      setError(snapshot.error);
    };
    shared.listeners.add(applySnapshot);
    applySnapshot(shared.snapshot);

    return () => {
      cancelled = true;
      shared.listeners.delete(applySnapshot);
      releaseSharedSubscription(connection, key, shared);
      setRows([]);
      setReady(false);
      setError(null);
    };
  }, [accessorName, connection, enabled, isActive, kind, tableQuery]);

  return [rows, ready, error];
}

export function useLiveTable<Row>(
  tableQuery: LiveTableQuery,
  accessorName: LiveTableName,
  options?: UseLiveTableOptions
): [Row[], boolean, string | null] {
  return useSharedLiveTable<Row>(tableQuery, accessorName, 'auth', options);
}

export function usePublicLiveTable<Row>(
  tableQuery: LiveTableQuery,
  accessorName: LiveTableName,
  options?: UseLiveTableOptions
): [Row[], boolean, string | null] {
  return useSharedLiveTable<Row>(tableQuery, accessorName, 'public', options);
}
