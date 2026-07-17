import { useEffect } from 'react';
import { useAuthSession } from '@/lib/auth-session';
import { isOidcTokenExpiredError } from '@/lib/session-recovery';

const OIDC_SESSION_RECOVERY_RETRY_INTERVAL_MS = 5_000;

/**
 * Converts a stale SpacetimeDB OIDC failure into a silent browser-session
 * refresh. The old connection is replaced when the refreshed ID token reaches
 * AuthenticatedSpacetimeShell, so read hooks retry against the new connection.
 */
export function useOidcSessionRecovery(error: unknown): boolean {
  const auth = useAuthSession();
  const refreshAuthSession = auth.refresh;
  const tokenExpired = isOidcTokenExpiredError(error);
  const canRecover = auth.status === 'authenticated';

  useEffect(() => {
    if (!tokenExpired || !canRecover) {
      return;
    }

    let cancelled = false;
    let retryId: number | null = null;

    const recover = async () => {
      await refreshAuthSession();
      if (!cancelled) {
        retryId = window.setTimeout(
          recover,
          OIDC_SESSION_RECOVERY_RETRY_INTERVAL_MS
        );
      }
    };

    void recover();

    return () => {
      cancelled = true;
      if (retryId !== null) {
        window.clearTimeout(retryId);
      }
    };
  }, [canRecover, refreshAuthSession, tokenExpired]);

  return tokenExpired && canRecover;
}
