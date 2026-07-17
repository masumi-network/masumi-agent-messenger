import { useCallback, useEffect, useMemo } from 'react';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { Identity } from 'spacetimedb';
import { routeTree } from './routeTree.gen';
import { ThemeProvider } from './lib/theme';
import {
  SpacetimeDBQueryClient,
  SpacetimeDBProvider,
} from 'spacetimedb/tanstack';
import { DbConnection, ErrorContext } from './module_bindings';
import { NotFoundPage } from './components/not-found-page';
import { AuthSessionProvider, useAuthSession } from './lib/auth-session';
import { buildScopedSpacetimeUri } from './lib/spacetime-connection-scope';
import { KeyVaultProvider } from './hooks/use-key-vault';
import { isOidcTokenExpiredError } from './lib/session-recovery';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME =
  import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'agentmessenger-dev';

const spacetimeDBQueryClient = new SpacetimeDBQueryClient();

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: spacetimeDBQueryClient.queryFn,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  },
});
spacetimeDBQueryClient.connect(queryClient);

let isPageExiting = false;

const onConnect = (conn: DbConnection, _identity: Identity) => {
  spacetimeDBQueryClient.setConnection(conn);
};

const onDisconnect = () => {
  spacetimeDBQueryClient.disconnect();
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  if (!isPageExiting) {
    console.error('Error connecting to SpacetimeDB:', err);
  }
  spacetimeDBQueryClient.disconnect();
};

export function AuthenticatedSpacetimeShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = useAuthSession();
  const authenticatedSession =
    auth.status === 'authenticated' ? auth.session : null;
  const sessionToken = authenticatedSession?.idToken ?? null;
  const refreshAuthSession = auth.refresh;
  const isServerRender = import.meta.env.SSR;
  const onAuthenticatedConnectError = useCallback(
    (_ctx: ErrorContext, err: Error) => {
      if (!isPageExiting && isOidcTokenExpiredError(err)) {
        void refreshAuthSession();
      } else if (!isPageExiting) {
        console.error('Error connecting to SpacetimeDB:', err);
      }
      spacetimeDBQueryClient.disconnect();
    },
    [refreshAuthSession]
  );

  useEffect(() => {
    const handlePageHide = () => {
      isPageExiting = true;
    };
    const handlePageShow = () => {
      isPageExiting = false;
    };

    isPageExiting = false;
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, []);

  useEffect(() => {
    if (auth.status === 'authenticated') {
      return;
    }
    spacetimeDBQueryClient.disconnect();
    queryClient.removeQueries({ queryKey: ['spacetimedb'] });
  }, [auth.status]);

  const connectionUri = useMemo(
    () => (sessionToken ? buildScopedSpacetimeUri(HOST, sessionToken) : null),
    [sessionToken]
  );

  useEffect(() => {
    if (!sessionToken) return;
    spacetimeDBQueryClient.disconnect();
  }, [sessionToken]);

  const connectionBuilder = useMemo(() => {
    if (!sessionToken || !connectionUri) {
      return null;
    }

    return DbConnection.builder()
      .withUri(connectionUri)
      .withDatabaseName(DB_NAME)
      .withToken(sessionToken)
      .onConnect(onConnect)
      .onDisconnect(onDisconnect)
      .onConnectError(onAuthenticatedConnectError);
  }, [connectionUri, onAuthenticatedConnectError, sessionToken]);

  const serverConnectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(HOST)
        .withDatabaseName(DB_NAME)
        .onConnect(onConnect)
        .onDisconnect(onDisconnect)
        .onConnectError(onConnectError),
    []
  );

  if (!authenticatedSession || !connectionBuilder) {
    return (
      <SpacetimeDBProvider
        connectionBuilder={serverConnectionBuilder}
        key={isServerRender ? 'ssr-shell' : 'anonymous-shell'}
      >
        {children}
      </SpacetimeDBProvider>
    );
  }

  return (
    <SpacetimeDBProvider
      connectionBuilder={connectionBuilder}
      key={connectionUri}
    >
      {children}
    </SpacetimeDBProvider>
  );
}

function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthSessionProvider>
        <KeyVaultProvider>
          <AuthenticatedSpacetimeShell>{children}</AuthenticatedSpacetimeShell>
        </KeyVaultProvider>
      </AuthSessionProvider>
    </ThemeProvider>
  );
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFoundPage,
    context: { queryClient },
    Wrap: ({ children }) => <AppProviders>{children}</AppProviders>,
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
