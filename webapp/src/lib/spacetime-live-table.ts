import { useEffect, useState } from 'react';
import { DbConnection, tables } from '@/module_bindings';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import {
  describeInboxAuthLeaseRefreshError,
  ensureInboxAuthLease,
} from './inbox-auth-lease';
import { deferEffectStateUpdate } from './effect-state';

type LiveTableName = keyof typeof tables;
type LiveTableQuery = (typeof tables)[LiveTableName];

type TableLike<Row> = {
  iter(): Iterable<Row>;
  onInsert(callback: (ctx: unknown, row: Row) => void): void;
  removeOnInsert(callback: (ctx: unknown, row: Row) => void): void;
  onDelete(callback: (ctx: unknown, row: Row) => void): void;
  removeOnDelete(callback: (ctx: unknown, row: Row) => void): void;
  onUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate?(callback: (ctx: unknown, oldRow: Row, newRow: Row) => void): void;
};

function getTable<Row>(connection: DbConnection, accessorName: LiveTableName): TableLike<Row> {
  return connection.db[accessorName] as unknown as TableLike<Row>;
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

export function useLiveTable<Row>(
  tableQuery: LiveTableQuery,
  accessorName: LiveTableName
): [Row[], boolean, string | null] {
  const connectionState = useSpacetimeDB();
  const [rows, setRows] = useState<Row[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;

  useEffect(() => {
    if (!isActive || !connection) {
      return;
    }

    let cancelled = false;
    let subscription: { unsubscribe: () => void } | null = null;
    let removeListeners: (() => void) | null = null;

    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setReady(false);
        setError(null);
      }
    });

    void ensureInboxAuthLease(connection)
      .then(() => {
        if (cancelled) {
          return;
        }

        const table = getTable<Row>(connection, accessorName);
        const refresh = () => {
          setRows(Array.from(table.iter()));
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
        removeListeners = () => {
          table.removeOnInsert(handleInsert);
          table.removeOnDelete(handleDelete);
          table.removeOnUpdate?.(handleUpdate);
        };

        refresh();

        subscription = connection
          .subscriptionBuilder()
          .onApplied(() => {
            refresh();
            setReady(true);
            setError(null);
          })
          .onError(subscriptionError => {
            setReady(false);
            setError(readSubscriptionError(subscriptionError));
          })
          .subscribe([tableQuery]);
      })
      .catch(error => {
        if (!cancelled) {
          setReady(false);
          setError(describeInboxAuthLeaseRefreshError(error));
        }
      });

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
      removeListeners?.();
      setRows([]);
      setReady(false);
      setError(null);
    };
  }, [accessorName, connection, isActive, tableQuery]);

  return [rows, ready, error];
}
