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

export function getSessionRefreshDelayMs(
  session: AuthenticatedBrowserSession,
  nowMs = Date.now()
): number {
  const expiresAtMs = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAtMs)
    ? Math.max(30_000, Math.min(60_000, expiresAtMs - nowMs - 60_000))
    : 60_000;
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
    setError(
      sessionError instanceof Error
        ? sessionError.message
        : 'Unable to load auth session'
    );
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

    const timeoutId = window.setTimeout(() => {
      fetchAuthSession()
        .then(applySessionResult)
        .catch(applySessionError);
    }, getSessionRefreshDelayMs(session));

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [applySessionError, applySessionResult, session]);

  useEffect(() => {
    if (!session) return;

    const msUntilExpiry = getSessionExpiryDelayMs(session);
    if (msUntilExpiry === null) return;

    const expireSession = () => {
      setSession(null);
      setStatus('anonymous');
      setError(null);
    };

    if (msUntilExpiry === 0) {
      expireSession();
      return;
    }

    const timeoutId = window.setTimeout(expireSession, msUntilExpiry);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [session]);

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
      fetchAuthSession()
        .then(applySessionResult)
        .catch(applySessionError)
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
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshFromBrowserEvent);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [applySessionError, applySessionResult]);

  useEffect(() => {
    const previousSession = previousSessionRef.current;
    const nextSession = status === 'authenticated' ? session : null;

    if (shouldClearUnlockedSessionMaterial(previousSession, nextSession)) {
      clearUnlockedKeySession();
    }

    previousSessionRef.current = nextSession;
  }, [session, status]);

  const value = useMemo<AuthSessionContextValue>(
    () => ({
      status,
      session,
      error,
      refresh: async () => {
        try {
          const result = await fetchAuthSession();
          applySessionResult(result);
        } catch (sessionError) {
          applySessionError(sessionError);
        }
      },
    }),
    [applySessionError, applySessionResult, error, session, status]
  );

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
}
