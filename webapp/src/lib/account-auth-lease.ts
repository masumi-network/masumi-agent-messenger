import type { DbConnection } from '@/module_bindings';

// Mirrors the Rust strings raised by `helpers::accounts::get_owned_account` and
// `helpers::oidc::require_oidc_claims`. Keep this set in sync if those messages change.
const OPTIONAL_LEASE_REFRESH_MESSAGES = new Set([
  'Caller has no account for this identity',
  'OIDC authentication is required before this action',
]);

// Server-side lease window is 5 minutes (`ACCOUNT_AUTH_LEASE_DURATION_MS`); refresh well
// before that so a long-idle tab whose subscriptions are mounted does not silently lose
// authorization between user actions.
const ACCOUNT_AUTH_LEASE_REFRESH_INTERVAL_MS = 4 * 60_000;

const refreshesByConnection = new WeakMap<DbConnection, Promise<void>>();
const refreshTimersByConnection = new WeakMap<DbConnection, ReturnType<typeof setInterval>>();

/**
 * Marker error raised when a procedure call fails because the account auth lease has lapsed
 * (or was never established for this identity). Distinguishable from arbitrary procedure
 * failures so callers can react with a fresh `ensureAccountAuthLease` instead of relying on
 * brittle error-message substring matching.
 */
export class AccountAuthLeaseError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AccountAuthLeaseError';
    this.cause = options?.cause;
  }
}

export function isAccountAuthLeaseError(error: unknown): error is AccountAuthLeaseError {
  return error instanceof AccountAuthLeaseError;
}

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

export function isLeaseRefreshHintMessage(message: string | null | undefined): boolean {
  return message !== null && message !== undefined && OPTIONAL_LEASE_REFRESH_MESSAGES.has(message);
}

export function describeAccountAuthLeaseRefreshError(error: unknown): string {
  return errorMessage(error) ?? 'Unable to refresh inbox authorization.';
}

export function ensureAccountAuthLease(conn: DbConnection): Promise<void> {
  const existing = refreshesByConnection.get(conn);
  if (existing) {
    return existing;
  }

  const refresh = Promise.resolve(conn.reducers.refreshAccountAuthLease({}))
    .then(() => undefined)
    .catch(error => {
      if (isOptionalLeaseRefreshFailure(error)) {
        return;
      }
      throw error;
    })
    .finally(() => {
      refreshesByConnection.delete(conn);
    });

  refreshesByConnection.set(conn, refresh);
  scheduleAccountAuthLeaseRefresh(conn);
  return refresh;
}

/**
 * Start a periodic background refresh tied to this connection. Idempotent — calling more
 * than once is a no-op. The timer is cleared with `cancelAccountAuthLeaseRefresh` on
 * disconnect; otherwise it runs until the connection is garbage-collected.
 */
export function scheduleAccountAuthLeaseRefresh(conn: DbConnection): void {
  if (refreshTimersByConnection.has(conn)) {
    return;
  }
  const timer = setInterval(() => {
    void ensureAccountAuthLease(conn).catch(() => {
      // Background refresh failures surface through subsequent procedure calls; the next
      // user action triggers a fresh attempt with proper error reporting.
    });
  }, ACCOUNT_AUTH_LEASE_REFRESH_INTERVAL_MS);
  // Avoid keeping the Node test runner alive on a dangling interval.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  refreshTimersByConnection.set(conn, timer);
}

export function cancelAccountAuthLeaseRefresh(conn: DbConnection): void {
  const timer = refreshTimersByConnection.get(conn);
  if (timer) {
    clearInterval(timer);
    refreshTimersByConnection.delete(conn);
  }
}
