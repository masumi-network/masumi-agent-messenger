export type MasumiNetwork = 'preprod' | 'mainnet';
export type MasumiApiSession = {
  accessToken: string | null;
  grantedScopes?: string[];
};

type MasumiScopeErrorBody = {
  success?: boolean;
  error?: string;
};

function describeGrantedScopes(grantedScopes: string[] | undefined): string {
  if (!grantedScopes || grantedScopes.length === 0) {
    return 'none';
  }

  return grantedScopes.join(', ');
}

function scopeRecoveryMessage(
  requiredScope?: string,
  grantedScopes?: string[]
): string {
  const suffix = requiredScope ? ` Missing required scope: ${requiredScope}.` : '';
  return `masumi-agent-messenger already requests the full supported permission catalog during OIDC sign-in.${suffix} Sign in again to refresh the token. Current granted scopes: ${describeGrantedScopes(grantedScopes)}. If it still fails, update the user OIDC grants for this client in Masumi SaaS.`;
}

export function normalizeMasumiNetwork(network: string): MasumiNetwork {
  const normalized = network.trim().toLowerCase();
  if (normalized === 'preprod' || normalized === 'mainnet') {
    return normalized;
  }

  throw new Error('Masumi network must be explicit: preprod or mainnet');
}

export function getMasumiAccessToken(session: MasumiApiSession): string {
  const token = session.accessToken?.trim();
  if (!token) {
    throw new Error(
      `Masumi access_token missing. ${scopeRecoveryMessage(undefined, session.grantedScopes)}`
    );
  }
  return token;
}

export async function throwOnMasumiScopeFailure(
  response: Response,
  session?: MasumiApiSession
): Promise<void> {
  if (response.status !== 403) return;

  let body: MasumiScopeErrorBody | null;
  try {
    body = (await response.clone().json()) as MasumiScopeErrorBody;
  } catch {
    body = null; // Response wasn't JSON
  }

  if (typeof body?.error === 'string' && body.error.startsWith('Missing required scope: ')) {
    const requiredScope = body.error.slice('Missing required scope: '.length).trim();
    throw new Error(scopeRecoveryMessage(requiredScope, session?.grantedScopes));
  }
}

export async function fetchMasumiApi(
  session: MasumiApiSession,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${getMasumiAccessToken(session)}`);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  await throwOnMasumiScopeFailure(response, session);
  return response;
}
