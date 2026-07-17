import { useEffect, useMemo, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/tanstack';
import type { DbConnection } from '@/module_bindings';
import {
  describeAccountAuthLeaseRefreshError,
  ensureAccountAuthLease,
  isAccountAuthLeaseError,
  isLeaseRefreshHintMessage,
} from './account-auth-lease';
import { deferEffectStateUpdate } from './effect-state';
import { useOidcSessionRecovery } from '@/hooks/use-oidc-session-recovery';
import { isOidcTokenExpiredError } from './session-recovery';

type ProcedureSnapshotState<Row> = {
  rows: Row[];
  ready: boolean;
  error: string | null;
};

function readProcedureError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'SpacetimeDB procedure read failed';
}

export function useProcedureSnapshot<Row>(
  loader: (conn: DbConnection) => Promise<Row[]>,
  refreshKey: string | number | bigint | boolean | null | undefined = null
): [Row[], boolean, string | null] {
  const connectionState = useSpacetimeDB();
  const [state, setState] = useState<ProcedureSnapshotState<Row>>({
    rows: [],
    ready: false,
    error: null,
  });
  const connection = connectionState.getConnection?.() as DbConnection | null;
  const isActive = connectionState.isActive && connection !== null;
  const stableRefreshKey = useMemo(
    () => (typeof refreshKey === 'bigint' ? refreshKey.toString() : refreshKey),
    [refreshKey]
  );

  useEffect(() => {
    if (!isActive || !connection) {
      return deferEffectStateUpdate(() => {
        setState({ rows: [], ready: false, error: null });
      });
    }

    let cancelled = false;
    deferEffectStateUpdate(() => {
      if (!cancelled) {
        setState(current => ({ ...current, ready: false, error: null }));
      }
    });

    void ensureAccountAuthLease(connection)
      .then(() => loader(connection))
      .then(rows => {
        if (!cancelled) {
          setState({ rows, ready: true, error: null });
        }
      })
      .catch(error => {
        if (!cancelled) {
          // Tell lease errors apart from generic procedure failures explicitly. The substring
          // check on the literal hint set in `account-auth-lease.ts` is the deliberate fallback
          // for raw `Error`s thrown by reducers; the typed `AccountAuthLeaseError` path is the
          // preferred route for callers that wrap their own errors.
          const message = error instanceof Error ? error.message : null;
          const isLeaseError =
            isAccountAuthLeaseError(error) || isLeaseRefreshHintMessage(message);
          setState(current => ({
            rows: isOidcTokenExpiredError(error) ? current.rows : [],
            ready: false,
            error: isLeaseError
              ? describeAccountAuthLeaseRefreshError(error)
              : readProcedureError(error),
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connection, isActive, loader, stableRefreshKey]);

  const recoveringSession = useOidcSessionRecovery(state.error);

  return [
    state.rows,
    recoveringSession ? state.rows.length > 0 : state.ready,
    recoveringSession ? null : state.error,
  ];
}
