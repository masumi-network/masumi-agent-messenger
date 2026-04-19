import type { DbConnection } from '@/module_bindings';

const OPTIONAL_LEASE_REFRESH_MESSAGES = new Set([
  'No inbox is bound to this identity',
  'OIDC authentication is required before this action',
]);

const refreshesByConnection = new WeakMap<DbConnection, Promise<void>>();

function errorMessage(error: unknown): string | null {
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

function isOptionalLeaseRefreshFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return message !== null && OPTIONAL_LEASE_REFRESH_MESSAGES.has(message);
}

export function describeInboxAuthLeaseRefreshError(error: unknown): string {
  return errorMessage(error) ?? 'Unable to refresh inbox authorization.';
}

export function ensureInboxAuthLease(conn: DbConnection): Promise<void> {
  const existing = refreshesByConnection.get(conn);
  if (existing) {
    return existing;
  }

  const refresh = Promise.resolve(conn.reducers.refreshInboxAuthLease({}))
    .then(() => undefined)
    .catch(error => {
      if (isOptionalLeaseRefreshFailure(error)) {
        return;
      }
      refreshesByConnection.delete(conn);
      throw error;
    });

  refreshesByConnection.set(conn, refresh);
  return refresh;
}
