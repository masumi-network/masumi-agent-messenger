import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { clearUnlockedKeySession } from './agent-session';

export type AuthenticatedBrowserSession = {
  authenticated: true;
  idToken: string;
  grantedScopes: string[];
  expiresAt: string;
  user: {
    issuer: string;
    subject: string;
    audience: string[];
    sessionId?: string;
    jwtId?: string;
    email: string | null;
    emailVerified: boolean;
    name?: string;
  };
};

export type BrowserAuthSession =
  | { authenticated: false }
  | AuthenticatedBrowserSession;

type AuthSessionStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

type AuthSessionContextValue = {
  status: AuthSessionStatus;
  session: AuthenticatedBrowserSession | null;
  error: string | null;
  refresh: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);
const INTERACTIVE_SESSION_REFRESH_MIN_INTERVAL_MS = 5_000;
const SESSION_REFRESH_RETRY_INTERVAL_MS = 5_000;

export function getSessionRefreshDelayMs(
  session: AuthenticatedBrowserSession,
  nowMs = Date.now()
): number {
  const expiresAtMs = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAtMs)
    ? Math.max(1_000, Math.min(60_000, expiresAtMs - nowMs - 60_000))
    : 60_000;
}

export function getSessionRefreshRetryDelayMs(
  session: AuthenticatedBrowserSession,
  nowMs = Date.now()
): number | null {
  const msUntilExpiry = getSessionExpiryDelayMs(session, nowMs);
  if (msUntilExpiry === null) {
    return SESSION_REFRESH_RETRY_INTERVAL_MS;
  }
  if (msUntilExpiry <= 0) {
    return null;
  }
  return Math.min(
    SESSION_REFRESH_RETRY_INTERVAL_MS,
    Math.max(250, msUntilExpiry - 250)
  );
}

export function getSessionExpiryDelayMs(
  session: AuthenticatedBrowserSession,
  nowMs = Date.now()
): number | null {
  const expiresAtMs = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, expiresAtMs - nowMs);
}

function buildSessionIdentityKey(session: AuthenticatedBrowserSession): string {
  return [
    session.user.issuer,
    session.user.subject,
    session.user.email?.trim().toLowerCase() ?? '',
  ].join('|');
}

export function shouldClearUnlockedSessionMaterial(
  previousSession: AuthenticatedBrowserSession | null,
  nextSession: BrowserAuthSession | null
): boolean {
  if (!previousSession) {
    return false;
  }

  if (!nextSession || !nextSession.authenticated) {
    return true;
  }

  return buildSessionIdentityKey(previousSession) !== buildSessionIdentityKey(nextSession);
}

function sameBrowserSession(
  left: AuthenticatedBrowserSession | null,
  right: AuthenticatedBrowserSession
): boolean {
  if (!left) return false;

  return (
    left.idToken === right.idToken &&
    left.grantedScopes.length === right.grantedScopes.length &&
    left.grantedScopes.every((scope, index) => scope === right.grantedScopes[index]) &&
    left.expiresAt === right.expiresAt &&
    left.user.issuer === right.user.issuer &&
    left.user.subject === right.user.subject &&
    left.user.sessionId === right.user.sessionId &&
    left.user.jwtId === right.user.jwtId &&
    left.user.email === right.user.email &&
    left.user.emailVerified === right.user.emailVerified &&
    left.user.name === right.user.name &&
    left.user.audience.length === right.user.audience.length &&
    left.user.audience.every((audience, index) => audience === right.user.audience[index])
  );
}

export function getFollowUpSessionRefreshDelayMs(
  currentSession: AuthenticatedBrowserSession,
  result: BrowserAuthSession,
  nowMs = Date.now()
): number | null {
  return result.authenticated && sameBrowserSession(currentSession, result)
    ? getSessionRefreshDelayMs(result, nowMs)
    : null;
}

function readAuthSessionError(sessionError: unknown): string {
  return sessionError instanceof Error
    ? sessionError.message
    : 'Unable to load auth session';
}

async function fetchAuthSession(signal?: AbortSignal): Promise<BrowserAuthSession> {
  const response = await fetch('/auth/session', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Unable to load auth session (${response.status})`);
  }

  return (await response.json()) as BrowserAuthSession;
}

export function buildLoginHref(returnTo?: string): string {
  if (!returnTo) return '/auth/login';

  const searchParams = new URLSearchParams();
  searchParams.set('returnTo', returnTo);
  return `/auth/login?${searchParams.toString()}`;
}

export function useAuthSession(): AuthSessionContextValue {
  const context = useContext(AuthSessionContext);
  if (!context) {
    throw new Error('useAuthSession must be used within AuthSessionProvider');
  }
  return context;
}

export function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<AuthSessionStatus>('loading');
  const [session, setSession] = useState<AuthenticatedBrowserSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousSessionRef = useRef<AuthenticatedBrowserSession | null>(null);
  const refreshInFlightRef = useRef<Promise<BrowserAuthSession> | null>(null);

  const applySessionResult = useCallback((result: BrowserAuthSession) => {
    if (result.authenticated) {
      setSession(current =>
        sameBrowserSession(current, result) ? current : result
      );
      setStatus('authenticated');
      setError(null);
    } else {
      setSession(null);
      setStatus('anonymous');
      setError(null);
    }
  }, []);

  const applySessionError = useCallback((sessionError: unknown) => {
    setSession(null);
    setStatus('error');
    setError(readAuthSessionError(sessionError));
  }, []);

  const applyRefreshError = useCallback((sessionError: unknown) => {
    setError(readAuthSessionError(sessionError));
    setStatus(current => (current === 'authenticated' ? current : 'error'));
  }, []);

  const refreshFromServer = useCallback((): Promise<BrowserAuthSession> => {
    const existing = refreshInFlightRef.current;
    if (existing) {
      return existing;
    }

    const refresh = fetchAuthSession().finally(() => {
      if (refreshInFlightRef.current === refresh) {
        refreshInFlightRef.current = null;
      }
    });
    refreshInFlightRef.current = refresh;
    return refresh;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAuthSession(controller.signal)
      .then(applySessionResult)
      .catch(sessionError => {
        if ((sessionError as Error).name === 'AbortError') return;
        applySessionError(sessionError);
      });
    return () => {
      controller.abort();
    };
  }, [applySessionError, applySessionResult]);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    let timeoutId: number | null = null;

    const scheduleRefresh = (delayMs: number) => {
      timeoutId = window.setTimeout(() => {
        void refreshFromServer()
          .then(result => {
            if (cancelled) return;

            applySessionResult(result);
            const followUpDelay = getFollowUpSessionRefreshDelayMs(
              session,
              result
            );
            if (followUpDelay !== null) {
              scheduleRefresh(followUpDelay);
            }
          })
          .catch(sessionError => {
            if (cancelled) return;

            // A background refresh failure must not discard the authenticated
            // identity or its unlocked vault. Keep retrying while the expiry
            // recovery path requests a replacement session.
            setError(readAuthSessionError(sessionError));
            const retryDelay = getSessionRefreshRetryDelayMs(session);
            if (retryDelay !== null) {
              scheduleRefresh(retryDelay);
            }
          });
      }, delayMs);
    };

    scheduleRefresh(getSessionRefreshDelayMs(session));

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [applySessionResult, refreshFromServer, session]);

  useEffect(() => {
    if (!session) return;

    const msUntilExpiry = getSessionExpiryDelayMs(session);
    if (msUntilExpiry === null) return;

    let cancelled = false;
    let retryId: number | null = null;

    const refreshExpiredSession = () => {
      void refreshFromServer()
        .then(result => {
          if (!cancelled) {
            applySessionResult(result);
          }
        })
        .catch(sessionError => {
          if (cancelled) return;
          applyRefreshError(sessionError);
          retryId = window.setTimeout(refreshExpiredSession, SESSION_REFRESH_RETRY_INTERVAL_MS);
        });
    };

    if (msUntilExpiry === 0) {
      refreshExpiredSession();
    } else {
      retryId = window.setTimeout(refreshExpiredSession, msUntilExpiry);
    }

    return () => {
      cancelled = true;
      if (retryId !== null) {
        window.clearTimeout(retryId);
      }
    };
  }, [applyRefreshError, applySessionResult, refreshFromServer, session]);

  useEffect(() => {
    let refreshInFlight = false;
    let lastInteractiveRefreshAt = 0;

    const refreshFromBrowserEvent = () => {
      const now = Date.now();
      if (
        refreshInFlight ||
        now - lastInteractiveRefreshAt < INTERACTIVE_SESSION_REFRESH_MIN_INTERVAL_MS
      ) {
        return;
      }

      refreshInFlight = true;
      lastInteractiveRefreshAt = now;
      refreshFromServer()
        .then(applySessionResult)
        .catch(applyRefreshError)
        .finally(() => {
          refreshInFlight = false;
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshFromBrowserEvent();
      }
    };

    window.addEventListener('focus', refreshFromBrowserEvent);
    window.addEventListener('online', refreshFromBrowserEvent);
    window.addEventListener('pageshow', refreshFromBrowserEvent);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshFromBrowserEvent);
      window.removeEventListener('online', refreshFromBrowserEvent);
      window.removeEventListener('pageshow', refreshFromBrowserEvent);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [applyRefreshError, applySessionResult, refreshFromServer]);

  useEffect(() => {
    const previousSession = previousSessionRef.current;
    const nextSession = status === 'authenticated' ? session : null;

    if (shouldClearUnlockedSessionMaterial(previousSession, nextSession)) {
      clearUnlockedKeySession();
    }

    previousSessionRef.current = nextSession;
  }, [session, status]);

  const refresh = useCallback(async () => {
    try {
      const result = await refreshFromServer();
      applySessionResult(result);
    } catch (sessionError) {
      applyRefreshError(sessionError);
    }
  }, [applyRefreshError, applySessionResult, refreshFromServer]);

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      status,
      session,
      error,
      refresh,
    }),
    [error, refresh, session, status]
  );

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
}
