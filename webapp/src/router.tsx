import { useEffect, useMemo } from 'react';
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

const onConnect = (conn: DbConnection, _identity: Identity) => {
  spacetimeDBQueryClient.setConnection(conn);
};

const onDisconnect = () => {
  console.log('Disconnected from SpacetimeDB');
  spacetimeDBQueryClient.disconnect();
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  console.error('Error connecting to SpacetimeDB:', err);
  spacetimeDBQueryClient.disconnect();
};

function fingerprintSessionToken(token: string): string {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function AuthenticatedSpacetimeShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = useAuthSession();
  const authenticatedSession =
    auth.status === 'authenticated' ? auth.session : null;
  const sessionToken = authenticatedSession?.idToken ?? null;
  const isServerRender = import.meta.env.SSR;

  useEffect(() => {
    if (auth.status === 'authenticated') {
      return;
    }
    spacetimeDBQueryClient.disconnect();
    queryClient.removeQueries({ queryKey: ['spacetimedb'] });
  }, [auth.status]);

  const connectionUri = useMemo(() => {
    if (!sessionToken) {
      return null;
    }

    const uri = new URL(HOST);
    uri.searchParams.set(
      '__session',
      fingerprintSessionToken(sessionToken)
    );
    return uri.toString();
  }, [sessionToken]);

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
      .onConnectError(onConnectError);
  }, [connectionUri, sessionToken]);

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
      key={sessionToken}
    >
      {children}
    </SpacetimeDBProvider>
  );
}

function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthSessionProvider>
        <AuthenticatedSpacetimeShell>{children}</AuthenticatedSpacetimeShell>
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
