import type { DbConnection } from '../../../webapp/src/module_bindings';
import { normalizeEmail } from '../../../shared/inbox-slug';
import {
  ensureAuthenticatedSession,
  type AuthSessionContext,
} from './auth';
import type { TaskReporter } from './command-runtime';
import { userError } from './errors';
import {
  connectAuthenticated,
  disconnectConnection,
  withExistingAuthenticatedConnection,
} from './spacetimedb';
import type { SecretStore } from './secret-store';

export type AuthenticatedSpacetimeRuntime = AuthSessionContext & {
  conn: DbConnection;
  normalizedEmail: string;
  reporter: TaskReporter;
};

export type AuthenticatedSpacetimeCommandParams = {
  profileName: string;
  reporter: TaskReporter;
  secretStore?: SecretStore;
};

function requireSessionEmail(auth: AuthSessionContext): string {
  const normalizedEmail = normalizeEmail(auth.claims.email ?? '');
  if (!normalizedEmail) {
    throw userError('Current OIDC session is missing an email claim.', {
      code: 'OIDC_EMAIL_MISSING',
    });
  }
  return normalizedEmail;
}

export function createAuthenticatedSpacetimeRuntime(params: {
  auth: AuthSessionContext;
  conn: DbConnection;
  reporter: TaskReporter;
}): AuthenticatedSpacetimeRuntime {
  return {
    ...params.auth,
    conn: params.conn,
    normalizedEmail: requireSessionEmail(params.auth),
    reporter: params.reporter,
  };
}

export async function withAuthenticatedSpacetimeRuntime<Result>(
  params: AuthenticatedSpacetimeCommandParams,
  run: (runtime: AuthenticatedSpacetimeRuntime) => Promise<Result>
): Promise<Result> {
  const auth = await ensureAuthenticatedSession(params);

  params.reporter.verbose?.('Connecting to SpacetimeDB');
  const { conn } = await connectAuthenticated({
    host: auth.profile.spacetimeHost,
    databaseName: auth.profile.spacetimeDbName,
    sessionToken: auth.session.idToken,
  });
  params.reporter.verbose?.('Connected to SpacetimeDB');

  try {
    return await run(
      createAuthenticatedSpacetimeRuntime({
        auth,
        conn,
        reporter: params.reporter,
      })
    );
  } finally {
    disconnectConnection(conn);
  }
}

export async function withExistingAuthenticatedSpacetimeRuntime<Result>(
  params: {
    auth: AuthSessionContext;
    conn: DbConnection;
    reporter: TaskReporter;
  },
  run: (runtime: AuthenticatedSpacetimeRuntime) => Promise<Result>
): Promise<Result> {
  const runtime = createAuthenticatedSpacetimeRuntime(params);

  return await withExistingAuthenticatedConnection(
    {
      conn: params.conn,
      host: params.auth.profile.spacetimeHost,
      databaseName: params.auth.profile.spacetimeDbName,
      sessionToken: params.auth.session.idToken,
    },
    () => run(runtime)
  );
}
