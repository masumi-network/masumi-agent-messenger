import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  appendStandardSecurityHeaders,
  assertSameOriginUnsafeRequest,
  resolveOidcRuntimeConfigFromEnv,
  resolveSessionSecretFromEnv,
} from './security';
import { getMasumiOidcScopeString, normalizeOidcScopeList } from '../../../shared/masumi-oidc-scopes';
import {
  GENERATED_MASUMI_OIDC_AUDIENCES,
  GENERATED_MASUMI_OIDC_CLIENT_ID,
  GENERATED_MASUMI_OIDC_ISSUER,
  GENERATED_OIDC_CONFIG_SOURCE,
} from '../../../shared/generated-oidc-config';
import { ensureWorkspaceEnvLoaded } from './workspace-env.server';

ensureWorkspaceEnvLoaded();
const FLOW_COOKIE_NAME = 'masumi_oidc_flow';
const SESSION_COOKIE_NAME = 'masumi_oidc_session';
const FLOW_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REFRESH_WINDOW_MS = 2 * 60 * 1000;

type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
};

type AuthorizationCodeTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type StoredOidcSession = {
  idToken: string;
  refreshToken?: string;
  accessToken?: string;
  grantedScopes?: string[];
  expiresAt: number;
  createdAt: number;
};

type OidcFlowCookie = {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
};

type IdTokenClaims = {
  issuer: string;
  subject: string;
  audience: string[];
  email: string | null;
  emailVerified: boolean;
  name?: string;
  nonce?: string;
  expiresAt: number;
};

type BrowserAuthSession =
  | { authenticated: false }
  | {
      authenticated: true;
      idToken: string;
      grantedScopes: string[];
      expiresAt: string;
      user: {
        issuer: string;
        subject: string;
        audience: string[];
        email: string | null;
        emailVerified: boolean;
        name?: string;
      };
    };

type AuthenticatedBrowserSession = Extract<BrowserAuthSession, { authenticated: true }>;

export type AuthenticatedRequestBrowserSession = AuthenticatedBrowserSession & {
  accessToken: string | null;
};

class OidcTokenExchangeError extends Error {
  oauthError?: string;
  oauthErrorDescription?: string;
}

let oidcMetadataCache:
  | {
      issuer: string;
      metadata: OidcMetadata;
      cachedAt: number;
    }
  | undefined;

function getOidcRuntimeConfig() {
  return resolveOidcRuntimeConfigFromEnv(process.env, {
    source: GENERATED_OIDC_CONFIG_SOURCE,
    issuer: GENERATED_MASUMI_OIDC_ISSUER,
    clientId: GENERATED_MASUMI_OIDC_CLIENT_ID,
    audiences: [...GENERATED_MASUMI_OIDC_AUDIENCES],
  });
}

function getIssuer(): string {
  return getOidcRuntimeConfig().issuer;
}

function getClientId(): string {
  return getOidcRuntimeConfig().clientId;
}

function getOidcScope(): string {
  return getMasumiOidcScopeString(process.env.MASUMI_OIDC_SCOPES);
}

function getSessionSecret(): Buffer {
  const secret = resolveSessionSecretFromEnv(process.env);

  return createHash('sha256').update(secret).digest();
}

/**
 * Detects whether the inbound request is served over HTTPS.
 *
 * When the app runs behind a reverse proxy that terminates TLS (DigitalOcean
 * App Platform, Cloudflare, Vercel, etc.) the upstream protocol is `http:`
 * while the user-facing connection is HTTPS. Trusting the `X-Forwarded-Proto`
 * / `Forwarded` headers from the proxy is required so cookies get the
 * `Secure` flag — without it, `SameSite=None` cookies are silently dropped
 * by browsers on cross-site redirects (the Orion/Brave OAuth state-cookie
 * bug).
 *
 * In production (`NODE_ENV === 'production'`) we force `true` even if no
 * proto headers are present — prod deployments always run behind TLS, and a
 * missing/misconfigured proxy header would silently break OAuth otherwise.
 */
function isSecureRequest(request: Request, url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto && forwardedProto.split(',')[0]?.trim() === 'https') {
    return true;
  }
  const forwarded = request.headers.get('forwarded');
  if (forwarded && /\bproto=https\b/i.test(forwarded)) return true;
  if (process.env.NODE_ENV === 'production') return true;
  return false;
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Buffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return Buffer.from(`${base64}${padding}`, 'base64');
}

function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(randomBytes(byteLength));
}

function encryptCookieValue(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getSessionSecret(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', base64UrlEncode(iv), base64UrlEncode(tag), base64UrlEncode(ciphertext)].join('.');
}

function decryptCookieValue<T>(value: string): T | null {
  const [version, ivPart, tagPart, ciphertextPart] = value.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      getSessionSecret(),
      base64UrlDecode(ivPart)
    );
    decipher.setAuthTag(base64UrlDecode(tagPart));
    const plaintext = Buffer.concat([
      decipher.update(base64UrlDecode(ciphertextPart)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return null;
  }
}

function parseCookies(request: Request): Map<string, string> {
  const cookieHeader = request.headers.get('cookie');
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
  }

  return cookies;
}

function readEncryptedCookie<T>(request: Request, name: string): T | null {
  const value = parseCookies(request).get(name);
  if (!value) return null;
  return decryptCookieValue<T>(value);
}

function serializeCookie(params: {
  name: string;
  value: string;
  request: Request;
  url: URL;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}): string {
  const secure = isSecureRequest(params.request, params.url);
  // SameSite=None requires Secure — browsers reject it otherwise. In insecure
  // contexts (local dev over HTTP) fall back to Lax so the cookie is still set.
  const sameSite =
    params.sameSite === 'None' && !secure ? 'Lax' : (params.sameSite ?? 'Lax');

  const segments = [
    `${params.name}=${encodeURIComponent(params.value)}`,
    'Path=/',
    `SameSite=${sameSite}`,
  ];

  if (params.maxAge !== undefined) {
    segments.push(`Max-Age=${params.maxAge}`);
  }
  if (params.expires) {
    segments.push(`Expires=${params.expires.toUTCString()}`);
  }
  if (params.httpOnly ?? true) {
    segments.push('HttpOnly');
  }
  if (secure) {
    segments.push('Secure');
  }

  return segments.join('; ');
}

function clearCookie(
  name: string,
  request: Request,
  url: URL,
  sameSite?: 'Lax' | 'Strict' | 'None',
): string {
  return serializeCookie({
    name,
    value: '',
    request,
    url,
    maxAge: 0,
    expires: new Date(0),
    sameSite,
  });
}

export function sanitizeReturnTo(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

function resolveRedirectUri(requestUrl: URL): string {
  return (
    process.env.MASUMI_OIDC_REDIRECT_URI ??
    new URL('/auth/callback', requestUrl.origin).toString()
  );
}

function resolvePostLogoutRedirectUri(requestUrl: URL): string {
  return (
    process.env.MASUMI_OIDC_POST_LOGOUT_REDIRECT_URI ??
    new URL('/', requestUrl.origin).toString()
  );
}

function createPkceChallenge(codeVerifier: string): string {
  return base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
}

async function getOidcMetadata(): Promise<OidcMetadata> {
  const issuer = getIssuer();
  if (
    oidcMetadataCache &&
    oidcMetadataCache.issuer === issuer &&
    Date.now() - oidcMetadataCache.cachedAt < 5 * 60 * 1000
  ) {
    return oidcMetadataCache.metadata;
  }

  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed (${response.status}) from ${issuer}/.well-known/openid-configuration`
    );
  }

  const metadata = (await response.json()) as Partial<OidcMetadata>;
  if (
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.issuer
  ) {
    throw new Error('OIDC discovery response is missing required endpoints');
  }

  const normalized = {
    issuer: metadata.issuer.replace(/\/+$/, ''),
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    end_session_endpoint: metadata.end_session_endpoint,
  } satisfies OidcMetadata;

  oidcMetadataCache = {
    issuer,
    metadata: normalized,
    cachedAt: Date.now(),
  };

  return normalized;
}

function parseBooleanClaim(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function parseStringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseNumericClaim(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const segments = idToken.split('.');
  if (segments.length < 2) {
    throw new Error('OIDC id_token is malformed');
  }

  const payload = JSON.parse(base64UrlDecode(segments[1]).toString('utf8')) as Record<
    string,
    unknown
  >;

  const issuer = parseStringClaim(payload.iss);
  const subject = parseStringClaim(payload.sub);
  const email = parseStringClaim(payload.email) ?? null;
  const name = parseStringClaim(payload.name);
  const nonce = parseStringClaim(payload.nonce);
  const expiresAtSeconds = parseNumericClaim(payload.exp);
  const audienceValue = payload.aud;
  const audience = Array.isArray(audienceValue)
    ? audienceValue.filter((value): value is string => typeof value === 'string')
    : typeof audienceValue === 'string'
      ? [audienceValue]
      : [];

  if (!issuer || !subject || !expiresAtSeconds) {
    throw new Error('OIDC id_token is missing iss, sub, or exp');
  }

  return {
    issuer,
    subject,
    audience,
    email,
    emailVerified: parseBooleanClaim(payload.email_verified),
    name,
    nonce,
    expiresAt: expiresAtSeconds * 1000,
  };
}

function toBrowserSession(session: StoredOidcSession): BrowserAuthSession {
  const claims = decodeIdTokenClaims(session.idToken);
  return {
    authenticated: true,
    idToken: session.idToken,
    grantedScopes: session.grantedScopes ?? [],
    expiresAt: new Date(session.expiresAt).toISOString(),
    user: {
      issuer: claims.issuer,
      subject: claims.subject,
      audience: claims.audience,
      email: claims.email,
      emailVerified: claims.emailVerified,
      name: claims.name,
    },
  };
}

function toAuthenticatedRequestSession(
  session: StoredOidcSession
): AuthenticatedRequestBrowserSession {
  const browserSession = toBrowserSession(session);
  if (!browserSession.authenticated) {
    throw new Error('Authenticated OIDC session expected');
  }

  return {
    ...browserSession,
    accessToken: session.accessToken ?? null,
  };
}

async function parseTokenResponse(response: Response): Promise<AuthorizationCodeTokenResponse> {
  const json = (await response.json()) as AuthorizationCodeTokenResponse;
  if (!response.ok) {
    const description = json.error_description ?? json.error ?? response.statusText;
    const error = new OidcTokenExchangeError(`OIDC token exchange failed: ${description}`);
    error.oauthError = json.error;
    error.oauthErrorDescription = json.error_description;
    throw error;
  }
  return json;
}

export function isRecoverableOidcSessionRefreshFailure(error: unknown): boolean {
  const errorRecord =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const oauthError =
    typeof errorRecord?.oauthError === 'string'
      ? errorRecord.oauthError.trim().toLowerCase()
      : error instanceof OidcTokenExchangeError
        ? error.oauthError?.trim().toLowerCase()
        : undefined;
  const description =
    typeof errorRecord?.oauthErrorDescription === 'string'
      ? errorRecord.oauthErrorDescription.trim().toLowerCase()
      : error instanceof OidcTokenExchangeError
        ? error.oauthErrorDescription?.trim().toLowerCase()
        : undefined;
  const message =
    error instanceof Error ? error.message.trim().toLowerCase() : String(error).trim().toLowerCase();
  const combined = [oauthError, description, message].filter(Boolean).join(' ');

  return (
    oauthError === 'invalid_grant' ||
    combined.includes('invalid refresh token') ||
    (combined.includes('refresh token') &&
      (combined.includes('expired') ||
        combined.includes('revoked') ||
        combined.includes('invalid') ||
        combined.includes('not active')))
  );
}

function normalizeStoredSession(response: AuthorizationCodeTokenResponse): StoredOidcSession {
  if (!response.id_token) {
    throw new Error('OIDC token response did not include an id_token');
  }

  const claims = decodeIdTokenClaims(response.id_token);
  return {
    idToken: response.id_token,
    refreshToken: response.refresh_token,
    accessToken: response.access_token,
    grantedScopes: normalizeOidcScopeList(response.scope),
    expiresAt: claims.expiresAt,
    createdAt: Date.now(),
  };
}

async function exchangeAuthorizationCode(params: {
  metadata: OidcMetadata;
  requestUrl: URL;
  code: string;
  codeVerifier: string;
}): Promise<StoredOidcSession> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('client_id', getClientId());
  body.set('redirect_uri', resolveRedirectUri(params.requestUrl));
  body.set('code_verifier', params.codeVerifier);

  const response = await fetch(params.metadata.token_endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  return normalizeStoredSession(await parseTokenResponse(response));
}

async function refreshStoredSession(
  session: StoredOidcSession,
  metadata: OidcMetadata
): Promise<StoredOidcSession | null> {
  if (!session.refreshToken) {
    return null;
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', getClientId());
  body.set('refresh_token', session.refreshToken);

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const refreshed = await parseTokenResponse(response);
  if (!refreshed.id_token) {
    return null;
  }

  const normalized = normalizeStoredSession(refreshed);
  return {
    ...normalized,
    grantedScopes:
      normalized.grantedScopes && normalized.grantedScopes.length > 0
        ? normalized.grantedScopes
        : session.grantedScopes ?? [],
    refreshToken: refreshed.refresh_token ?? session.refreshToken,
    accessToken: refreshed.access_token ?? session.accessToken,
    createdAt: session.createdAt,
  };
}

async function loadSession(request: Request): Promise<{
  session: StoredOidcSession | null;
  cookies: string[];
}> {
  const requestUrl = new URL(request.url);
  const stored = readEncryptedCookie<StoredOidcSession>(request, SESSION_COOKIE_NAME);
  if (!stored) {
    return {
      session: null,
      cookies: [],
    };
  }

  try {
    decodeIdTokenClaims(stored.idToken);
  } catch {
    return {
      session: null,
      cookies: [clearCookie(SESSION_COOKIE_NAME, request, requestUrl)],
    };
  }

  if (stored.expiresAt - Date.now() > SESSION_REFRESH_WINDOW_MS) {
    return {
      session: stored,
      cookies: [],
    };
  }

  const metadata = await getOidcMetadata();
  let refreshed: StoredOidcSession | null;
  try {
    refreshed = await refreshStoredSession(stored, metadata);
  } catch (error) {
    if (isRecoverableOidcSessionRefreshFailure(error)) {
      return {
        session: null,
        cookies: [clearCookie(SESSION_COOKIE_NAME, request, requestUrl)],
      };
    }
    throw error;
  }
  if (!refreshed) {
    return {
      session: null,
      cookies: [clearCookie(SESSION_COOKIE_NAME, request, requestUrl)],
    };
  }

  return {
    session: refreshed,
    cookies: [
      serializeCookie({
        name: SESSION_COOKIE_NAME,
        value: encryptCookieValue(refreshed),
        request,
        url: requestUrl,
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
    ],
  };
}

function redirectResponse(
  location: string,
  headers?: Headers,
  status: 302 | 303 = 302
): Response {
  const nextHeaders = headers ?? new Headers();
  nextHeaders.set('Location', location);
  nextHeaders.set('Cache-Control', 'no-store');
  appendStandardSecurityHeaders(nextHeaders, {
    includeDocumentCsp: true,
    isDev: process.env.NODE_ENV !== 'production',
  });
  return new Response(null, {
    status,
    headers: nextHeaders,
  });
}

function jsonResponse(body: BrowserAuthSession, cookies: string[] = []): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  appendStandardSecurityHeaders(headers);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers,
  });
}

function readSetCookieValues(headers: Headers): string[] {
  return Array.from(headers.entries())
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .map(([, value]) => value);
}

function textResponse(
  status: number,
  body: string,
  options?: {
    cookies?: string[];
  }
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  for (const cookie of options?.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  appendStandardSecurityHeaders(headers, {
    includeDocumentCsp: true,
    isDev: process.env.NODE_ENV !== 'production',
  });
  return new Response(body, {
    status,
    headers,
  });
}

export async function beginOidcLogin(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const metadata = await getOidcMetadata();
  const codeVerifier = randomBase64Url(48);
  const flowCookie: OidcFlowCookie = {
    state: randomBase64Url(24),
    nonce: randomBase64Url(24),
    codeVerifier,
    redirectUri: resolveRedirectUri(requestUrl),
    returnTo: sanitizeReturnTo(requestUrl.searchParams.get('returnTo')),
  };

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', getClientId());
  authorizeUrl.searchParams.set('redirect_uri', flowCookie.redirectUri);
  authorizeUrl.searchParams.set('scope', getOidcScope());
  authorizeUrl.searchParams.set('state', flowCookie.state);
  authorizeUrl.searchParams.set('nonce', flowCookie.nonce);
  authorizeUrl.searchParams.set('code_challenge', createPkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const headers = new Headers();
  headers.append(
    'Set-Cookie',
    serializeCookie({
      name: FLOW_COOKIE_NAME,
      value: encryptCookieValue(flowCookie),
      request,
      url: requestUrl,
      maxAge: FLOW_COOKIE_MAX_AGE_SECONDS,
      // Flow cookie must survive the cross-site POST→303→GET chain back from
      // the OIDC provider (masumi-saas). Safari/WebKit and Firefox with Total
      // Cookie Protection drop SameSite=Lax cookies on this chain; SameSite=None
      // (with Secure, set automatically in prod) is the standard OAuth fix.
      sameSite: 'None',
    })
  );

  return redirectResponse(authorizeUrl.toString(), headers);
}

export async function completeOidcLogin(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const error = requestUrl.searchParams.get('error');
  const errorDescription = requestUrl.searchParams.get('error_description');
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const flowCookie = readEncryptedCookie<OidcFlowCookie>(request, FLOW_COOKIE_NAME);

  const clearFlowHeaders = new Headers();
  clearFlowHeaders.append(
    'Set-Cookie',
    clearCookie(FLOW_COOKIE_NAME, request, requestUrl, 'None'),
  );

  if (error) {
    return textResponse(400, errorDescription ?? error, {
      cookies: readSetCookieValues(clearFlowHeaders),
    });
  }

  if (!flowCookie || !code || !state) {
    console.warn('[oidc callback] missing flow cookie or params', {
      hasFlowCookie: !!flowCookie,
      hasCode: !!code,
      hasState: !!state,
      cookieNames: [...parseCookies(request).keys()],
      referrer: request.headers.get('referer'),
      ua: request.headers.get('user-agent'),
    });
    return textResponse(400, 'Missing OIDC callback state', {
      cookies: readSetCookieValues(clearFlowHeaders),
    });
  }

  if (state !== flowCookie.state) {
    return textResponse(400, 'Invalid OIDC state', {
      cookies: readSetCookieValues(clearFlowHeaders),
    });
  }

  const metadata = await getOidcMetadata();
  const storedSession = await exchangeAuthorizationCode({
    metadata,
    requestUrl,
    code,
    codeVerifier: flowCookie.codeVerifier,
  });
  const claims = decodeIdTokenClaims(storedSession.idToken);
  if (claims.nonce !== flowCookie.nonce) {
    return textResponse(400, 'Invalid OIDC nonce', {
      cookies: readSetCookieValues(clearFlowHeaders),
    });
  }

  clearFlowHeaders.append(
    'Set-Cookie',
    serializeCookie({
      name: SESSION_COOKIE_NAME,
      value: encryptCookieValue(storedSession),
      request,
      url: requestUrl,
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    })
  );

  return redirectResponse(flowCookie.returnTo, clearFlowHeaders);
}

export async function readBrowserAuthSession(request: Request): Promise<Response> {
  const { session, cookies } = await loadSession(request);
  if (!session) {
    return jsonResponse({ authenticated: false }, cookies);
  }

  return jsonResponse(toBrowserSession(session), cookies);
}

export async function readAuthenticatedBrowserSession(
  request: Request
): Promise<{
  session: AuthenticatedRequestBrowserSession | null;
  cookies: string[];
}> {
  const { session, cookies } = await loadSession(request);
  if (!session) {
    return {
      session: null,
      cookies,
    };
  }

  return {
    session: toAuthenticatedRequestSession(session),
    cookies,
  };
}

export async function logoutOidcSession(request: Request): Promise<Response> {
  assertSameOriginUnsafeRequest(request);

  const requestUrl = new URL(request.url);
  const stored = readEncryptedCookie<StoredOidcSession>(request, SESSION_COOKIE_NAME);

  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(FLOW_COOKIE_NAME, request, requestUrl, 'None'));
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE_NAME, request, requestUrl));

  let metadata: OidcMetadata | null;
  try {
    metadata = await getOidcMetadata();
  } catch {
    return redirectResponse(resolvePostLogoutRedirectUri(requestUrl), headers, 303);
  }

  if (!metadata.end_session_endpoint) {
    return redirectResponse(resolvePostLogoutRedirectUri(requestUrl), headers, 303);
  }

  const logoutUrl = new URL(metadata.end_session_endpoint);
  logoutUrl.searchParams.set(
    'post_logout_redirect_uri',
    resolvePostLogoutRedirectUri(requestUrl)
  );
  if (stored?.idToken) {
    logoutUrl.searchParams.set('id_token_hint', stored.idToken);
  }

  return redirectResponse(logoutUrl.toString(), headers, 303);
}
