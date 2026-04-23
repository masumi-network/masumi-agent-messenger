import { webcrypto } from 'node:crypto';
import { getMasumiOidcScopeString, normalizeOidcScopeList } from '../../../shared/masumi-oidc-scopes';
export { DEFAULT_OIDC_CLIENT_ID, DEFAULT_OIDC_ISSUER } from './env';
import { CliError, connectivityError, userError } from './errors';

const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRES_IN_SECONDS = 30 * 60;
export const SESSION_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const EMAIL_VERIFICATION_REQUIRED_ERROR = 'email_verification_required';

export type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  /** RFC 8414-style extension; Better Auth publishes .../api/auth/device/code */
  device_authorization_endpoint?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

type VerificationEmailResponse = {
  status?: boolean;
  error?: string;
  error_description?: string;
};

export type StoredOidcSession = {
  idToken: string;
  refreshToken?: string;
  accessToken?: string;
  grantedScopes?: string[];
  expiresAt: number;
  createdAt: number;
};

export type IdTokenClaims = {
  issuer: string;
  subject: string;
  audience: string[];
  authorizedParty?: string;
  sessionId?: string;
  jwtId?: string;
  email: string | null;
  emailVerified: boolean;
  name?: string;
  nonce?: string;
  expiresAt: number;
  notBefore?: number;
};

export type DeviceAuthorizationChallenge = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: number;
  intervalSeconds: number;
};

export type OidcDebugLogger = (message: string) => void;

type DeviceTokenPollResult =
  | { kind: 'success'; session: StoredOidcSession }
  | { kind: 'pending' }
  | { kind: 'slow_down' };

type DeviceTokenPollTransport = 'better-auth-device-token' | 'oauth2-token-endpoint';

type DeviceTokenPollRequest = {
  kind: DeviceTokenPollTransport;
  url: string;
  init: RequestInit;
  debugContext: string;
};

type IdTokenHeader = {
  alg: string;
  kid?: string;
};

type JwksKey = JsonWebKey & {
  alg?: string;
  kid?: string;
  kty?: string;
  use?: string;
};

type JwksCacheEntry = {
  jwksUri: string;
  keys: JwksKey[];
  cachedAt: number;
};

let jwksCache: JwksCacheEntry | undefined;

function summarizeDeviceCode(deviceCode: string): string {
  const suffix = deviceCode.slice(-6);
  return deviceCode.length <= 6 ? deviceCode : `...${suffix}`;
}

function base64UrlDecode(value: string): Buffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return Buffer.from(`${base64}${padding}`, 'base64');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function throwIdTokenValidation(message: string): never {
  throw userError(message, { code: 'OIDC_ID_TOKEN_INVALID' });
}

export function isStoredOidcSession(value: unknown): value is StoredOidcSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.idToken === 'string' &&
    record.idToken.trim().length > 0 &&
    (record.refreshToken === undefined || typeof record.refreshToken === 'string') &&
    (record.accessToken === undefined || typeof record.accessToken === 'string') &&
    (record.grantedScopes === undefined ||
      (Array.isArray(record.grantedScopes) &&
        record.grantedScopes.every(scope => typeof scope === 'string'))) &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  );
}

function parseStringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseBooleanClaim(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function parseNumericClaim(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = parseNumericClaim(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function isRecoverableSessionRefreshFailure(response: TokenResponse): boolean {
  const oauthError = response.error?.trim().toLowerCase();
  const description = response.error_description?.trim().toLowerCase();
  const combined = [oauthError, description].filter(Boolean).join(' ');

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

function parseTokenError(response: TokenResponse, statusText: string): never {
  if (isRecoverableSessionRefreshFailure(response)) {
    throw userError('Your sign-in session expired or was revoked. Run `masumi-agent-messenger auth login` again.', {
      code: 'AUTH_REQUIRED',
    });
  }

  const description = response.error_description ?? response.error ?? statusText;
  throw connectivityError(`OIDC token exchange failed: ${description}`, {
    code: 'OIDC_TOKEN_EXCHANGE_FAILED',
  });
}

async function parseJsonResponse<T extends object>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw connectivityError('OIDC endpoint returned invalid JSON.', {
      code: 'OIDC_RESPONSE_INVALID',
      cause: error,
    });
  }
}

function toDeviceEndpoint(metadata: OidcMetadata, path: string): string {
  const base = resolveBetterAuthBaseUrl(metadata);
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
}

function createBetterAuthDeviceTokenPollRequest(params: {
  metadata: OidcMetadata;
  clientId: string;
  deviceCode: string;
}): DeviceTokenPollRequest {
  return {
    kind: 'better-auth-device-token',
    url: params.metadata.device_authorization_endpoint!.trim().replace(/\/device\/code\/?$/i, '/device/token'),
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: params.deviceCode,
        client_id: params.clientId,
      }),
    },
    debugContext: `client_id=${params.clientId}, device_code=${summarizeDeviceCode(params.deviceCode)}, grant_type=device_code`,
  };
}

function createOauthDeviceTokenPollRequest(params: {
  metadata: OidcMetadata;
  clientId: string;
  deviceCode: string;
}): DeviceTokenPollRequest {
  return {
    kind: 'oauth2-token-endpoint',
    url: params.metadata.token_endpoint,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: params.deviceCode,
        client_id: params.clientId,
      }),
    },
    debugContext: `client_id=${params.clientId}, device_code=${summarizeDeviceCode(params.deviceCode)}, grant_type=device_code`,
  };
}

function createOrderedDeviceTokenPollRequests(params: {
  metadata: OidcMetadata;
  clientId: string;
  deviceCode: string;
}): DeviceTokenPollRequest[] {
  const oauthRequest = createOauthDeviceTokenPollRequest(params);
  const requests: DeviceTokenPollRequest[] = [];
  const raw = params.metadata.device_authorization_endpoint?.trim();
  const betterAuthRequest =
    raw && /\/device\/code\/?$/i.test(raw)
      ? createBetterAuthDeviceTokenPollRequest({
          metadata: params.metadata,
          clientId: params.clientId,
          deviceCode: params.deviceCode,
        })
      : null;

  const pushUnique = (request: DeviceTokenPollRequest | null): void => {
    if (!request) {
      return;
    }

    if (
      requests.some(
        existing =>
          existing.kind === request.kind && existing.url === request.url
      )
    ) {
      return;
    }

    requests.push(request);
  };

  pushUnique(oauthRequest);
  pushUnique(betterAuthRequest);
  return requests;
}

function describeDeviceAuthorizationError(payload: {
  error?: string;
  error_description?: string;
}): string {
  return payload.error_description ?? payload.error ?? 'unknown error';
}

function toDeviceStartError(
  response: Response,
  payload: DeviceCodeResponse
): Error {
  const description = describeDeviceAuthorizationError(payload);

  if (payload.error === 'invalid_client' || payload.error === 'invalid_scope') {
    return userError(`Device authorization failed: ${description}`, {
      code: 'OIDC_DEVICE_REQUEST_INVALID',
    });
  }

  return connectivityError(`Device authorization failed: ${description}`, {
    code: response.ok ? 'OIDC_DEVICE_REQUEST_FAILED' : 'OIDC_DEVICE_REQUEST_UNAVAILABLE',
  });
}

function toVerificationEmailError(
  response: Response,
  payload: VerificationEmailResponse
): Error {
  const description = describeDeviceAuthorizationError(payload);

  if (payload.error === 'invalid_email' || payload.error === 'invalid_request') {
    return userError(`Verification email request failed: ${description}`, {
      code: 'OIDC_VERIFICATION_EMAIL_INVALID',
    });
  }

  return connectivityError(`Verification email request failed: ${description}`, {
    code: response.ok
      ? 'OIDC_VERIFICATION_EMAIL_FAILED'
      : 'OIDC_VERIFICATION_EMAIL_UNAVAILABLE',
  });
}

function describePollTransport(kind: DeviceTokenPollTransport): string {
  if (kind === 'better-auth-device-token') {
    return 'Better Auth device token endpoint';
  }

  return 'OAuth token endpoint';
}

function summarizeTokenPayload(payload: TokenResponse): string {
  const parts = [
    `error=${payload.error ?? 'none'}`,
    `error_description=${payload.error_description ?? 'none'}`,
    `id_token=${payload.id_token ? 'present' : 'missing'}`,
    `access_token=${payload.access_token ? 'present' : 'missing'}`,
    `refresh_token=${payload.refresh_token ? 'present' : 'missing'}`,
    `scope=${payload.scope ? 'present' : 'missing'}`,
  ];

  return parts.join(', ');
}

function debugLogRequest(
  debug: OidcDebugLogger | undefined,
  request: DeviceTokenPollRequest
): void {
  debug?.(
    `Polling ${describePollTransport(request.kind)} at ${request.url} (${request.debugContext})`
  );
}

function debugLogResponse(
  debug: OidcDebugLogger | undefined,
  request: DeviceTokenPollRequest,
  response: Response,
  payload: TokenResponse
): void {
  debug?.(
    `${describePollTransport(request.kind)} responded ${response.status}: ${summarizeTokenPayload(payload)}`
  );
}

function withPollContext(error: unknown, context: string): Error {
  if (error instanceof CliError) {
    return new CliError(`${error.message} (${context})`, {
      exitCode: error.exitCode,
      code: error.code,
      cause: error,
    });
  }

  if (error instanceof Error) {
    return new Error(`${error.message} (${context})`, {
      cause: error,
    });
  }

  return new Error(`${String(error)} (${context})`);
}

async function fetchDeviceTokenPollResponse(params: {
  request: DeviceTokenPollRequest;
  debug?: OidcDebugLogger;
}): Promise<{
  request: DeviceTokenPollRequest;
  response: Response;
  payload: TokenResponse;
}> {
  debugLogRequest(params.debug, params.request);
  try {
    const response = await fetch(params.request.url, params.request.init);
    const payload = await parseJsonResponse<TokenResponse>(response);
    debugLogResponse(params.debug, params.request, response, payload);

    return {
      request: params.request,
      response,
      payload,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    params.debug?.(
      `${describePollTransport(params.request.kind)} threw before a response at ${params.request.url}: ${detail}`
    );
    throw withPollContext(
      error,
      `${describePollTransport(params.request.kind).toLowerCase()} request failed at ${params.request.url}`
    );
  }
}

function canRetryDevicePollWithAlternateTransport(params: {
  response: Response;
  payload: TokenResponse;
}): boolean {
  switch (params.payload.error) {
    case undefined:
      return !params.response.ok;
    case 'authorization_pending':
    case 'slow_down':
    case 'access_denied':
    case 'expired_token':
    case 'invalid_client':
      return false;
    default:
      return true;
  }
}

function toDevicePollError(payload: TokenResponse): Error {
  switch (payload.error) {
    case 'access_denied':
      if (payload.error_description === EMAIL_VERIFICATION_REQUIRED_ERROR) {
        return userError(
          'Device authorization failed: email verification required. Verify your email in Masumi SaaS and try again. If you need a new verification email, run `masumi-agent-messenger account verification resend --email you@example.com`.',
          {
            code: 'OIDC_EMAIL_VERIFICATION_REQUIRED',
          }
        );
      }

      if (payload.error_description && payload.error_description !== payload.error) {
        return userError(`Device authorization failed: ${payload.error_description}`, {
          code: 'OIDC_DEVICE_ACCESS_DENIED',
        });
      }

      return userError('Device authorization was denied by the user.', {
        code: 'OIDC_DEVICE_ACCESS_DENIED',
      });
    case 'expired_token':
      return userError('The device authorization expired. Run `masumi-agent-messenger account login` again.', {
        code: 'OIDC_DEVICE_EXPIRED',
      });
    case 'invalid_client':
      return userError(
        `Device authorization failed: ${describeDeviceAuthorizationError(payload)}`,
        {
          code: 'OIDC_DEVICE_REQUEST_INVALID',
        }
      );
    case 'invalid_grant':
      return userError(
        `Device authorization failed: ${describeDeviceAuthorizationError(payload)}`,
        {
          code: 'OIDC_DEVICE_POLL_FAILED',
        }
      );
    default:
      return connectivityError(
        `Device authorization failed: ${describeDeviceAuthorizationError(payload)}`,
        {
          code: 'OIDC_DEVICE_POLL_FAILED',
        }
      );
  }
}

export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

export async function discoverOidcMetadata(issuer: string): Promise<OidcMetadata> {
  const normalizedIssuer = normalizeIssuer(issuer);
  const response = await fetch(`${normalizedIssuer}/.well-known/openid-configuration`, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw connectivityError(
      `OIDC discovery failed (${response.status}) from ${normalizedIssuer}/.well-known/openid-configuration`,
      {
        code: 'OIDC_DISCOVERY_FAILED',
      }
    );
  }

  const metadata = (await response.json()) as Partial<OidcMetadata> & {
    device_authorization_endpoint?: string;
  };
  if (
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.jwks_uri ||
    !metadata.issuer
  ) {
    throw connectivityError('OIDC discovery response is missing required endpoints', {
      code: 'OIDC_DISCOVERY_INVALID',
    });
  }

  const normalized = {
    issuer: normalizeIssuer(metadata.issuer),
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    jwks_uri: metadata.jwks_uri,
    end_session_endpoint: metadata.end_session_endpoint,
    device_authorization_endpoint: metadata.device_authorization_endpoint,
  } satisfies OidcMetadata;

  if (normalized.issuer !== normalizedIssuer) {
    throw connectivityError('OIDC discovery issuer does not match configured issuer', {
      code: 'OIDC_DISCOVERY_INVALID',
    });
  }

  return normalized;
}

export function resolveBetterAuthBaseUrl(
  metadata: Pick<OidcMetadata, 'issuer' | 'authorization_endpoint'>
): string {
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  const authorizePath = '/oauth2/authorize';

  if (authorizationUrl.pathname.endsWith(authorizePath)) {
    authorizationUrl.pathname = authorizationUrl.pathname.slice(
      0,
      -authorizePath.length
    );
    authorizationUrl.search = '';
    authorizationUrl.hash = '';
    return authorizationUrl.toString().replace(/\/+$/, '');
  }

  return `${normalizeIssuer(metadata.issuer)}/api/auth`;
}

export function getOidcScope(configuredScopes?: string): string {
  return getMasumiOidcScopeString(configuredScopes);
}

function decodeJwtJsonSegment(value: string, label: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(base64UrlDecode(value).toString('utf8')) as unknown;
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    // Fall through to a domain-specific validation error.
  }

  throwIdTokenValidation(`OIDC id_token ${label} is malformed.`);
}

function decodeIdTokenHeader(idToken: string): IdTokenHeader {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw userError('OIDC id_token is malformed.', { code: 'OIDC_ID_TOKEN_MALFORMED' });
  }

  const header = decodeJwtJsonSegment(segments[0], 'header');
  const alg = parseStringClaim(header.alg);
  if (!alg || alg.toLowerCase() === 'none') {
    throwIdTokenValidation('OIDC id_token uses an invalid signing algorithm.');
  }

  return {
    alg,
    kid: parseStringClaim(header.kid),
  };
}

export function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw userError('OIDC id_token is malformed.', { code: 'OIDC_ID_TOKEN_MALFORMED' });
  }

  const payload = decodeJwtJsonSegment(segments[1], 'payload');

  const issuer = parseStringClaim(payload.iss);
  const subject = parseStringClaim(payload.sub);
  const email = parseStringClaim(payload.email) ?? null;
  const name = parseStringClaim(payload.name);
  const nonce = parseStringClaim(payload.nonce);
  const authorizedParty = parseStringClaim(payload.azp);
  const sessionId = parseStringClaim(payload.sid);
  const jwtId = parseStringClaim(payload.jti);
  const expiresAtSeconds = parseNumericClaim(payload.exp);
  const notBeforeSeconds = parseNumericClaim(payload.nbf);
  const audienceValue = payload.aud;
  const audience = Array.isArray(audienceValue)
    ? audienceValue.filter((value): value is string => typeof value === 'string')
    : typeof audienceValue === 'string'
      ? [audienceValue]
      : [];

  if (!issuer || !subject || !expiresAtSeconds) {
    throw userError('OIDC id_token is missing iss, sub, or exp.', {
      code: 'OIDC_ID_TOKEN_INVALID',
    });
  }

  return {
    issuer,
    subject,
    audience,
    authorizedParty,
    sessionId,
    jwtId,
    email,
    emailVerified: parseBooleanClaim(payload.email_verified),
    name,
    nonce,
    expiresAt: expiresAtSeconds * 1000,
    notBefore: notBeforeSeconds === undefined ? undefined : notBeforeSeconds * 1000,
  };
}

function parseJwksKey(value: unknown): JwksKey | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.kty === 'string' ? (record as JwksKey) : null;
}

async function getOidcJwks(
  metadata: OidcMetadata,
  options: { forceRefresh?: boolean } = {}
): Promise<{ keys: JwksKey[]; fromCache: boolean }> {
  if (
    !options.forceRefresh &&
    jwksCache &&
    jwksCache.jwksUri === metadata.jwks_uri &&
    Date.now() - jwksCache.cachedAt < 5 * 60 * 1000
  ) {
    return { keys: jwksCache.keys, fromCache: true };
  }

  const response = await fetch(metadata.jwks_uri, {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw connectivityError(`OIDC JWKS fetch failed (${response.status}) from ${metadata.jwks_uri}`, {
      code: 'OIDC_JWKS_FETCH_FAILED',
    });
  }

  const payload = await parseJsonResponse<Record<string, unknown>>(response);
  const keysValue = payload.keys;
  if (!Array.isArray(keysValue)) {
    throw connectivityError('OIDC JWKS response is invalid.', {
      code: 'OIDC_JWKS_INVALID',
    });
  }

  const keys = keysValue.map(parseJwksKey).filter((key): key is JwksKey => key !== null);
  if (keys.length === 0) {
    throw connectivityError('OIDC JWKS response does not include signing keys.', {
      code: 'OIDC_JWKS_INVALID',
    });
  }

  jwksCache = {
    jwksUri: metadata.jwks_uri,
    keys,
    cachedAt: Date.now(),
  };
  return { keys, fromCache: false };
}

function isCompatibleJwksKey(key: JwksKey, algorithm: string): boolean {
  if (key.use && key.use !== 'sig') {
    return false;
  }
  if (key.alg && key.alg !== algorithm) {
    return false;
  }
  if (algorithm === 'RS256') {
    return key.kty === 'RSA';
  }
  if (algorithm === 'ES256') {
    return key.kty === 'EC' && key.crv === 'P-256';
  }
  return false;
}

type JwksKeyLookup =
  | { kind: 'found'; key: JwksKey }
  | { kind: 'missing' };

function findJwksKeyByHeader(keys: JwksKey[], header: IdTokenHeader): JwksKeyLookup {
  const compatible = keys.filter(key => isCompatibleJwksKey(key, header.alg));
  if (header.kid) {
    const key = compatible.find(candidate => candidate.kid === header.kid);
    return key ? { kind: 'found', key } : { kind: 'missing' };
  }

  if (compatible.length === 1) {
    return { kind: 'found', key: compatible[0] };
  }

  if (compatible.length === 0) {
    return { kind: 'missing' };
  }
  throwIdTokenValidation('OIDC id_token kid is required when multiple signing keys are published.');
}

async function importVerificationKey(header: IdTokenHeader, key: JwksKey): Promise<CryptoKey> {
  if (header.alg === 'RS256') {
    return webcrypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    ) as Promise<CryptoKey>;
  }

  if (header.alg === 'ES256') {
    return webcrypto.subtle.importKey(
      'jwk',
      key,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    ) as Promise<CryptoKey>;
  }

  throwIdTokenValidation(`OIDC id_token algorithm ${header.alg} is not supported.`);
}

async function verifyIdTokenSignature(params: {
  idToken: string;
  header: IdTokenHeader;
  key: JwksKey;
}): Promise<void> {
  const [encodedHeader, encodedPayload, encodedSignature] = params.idToken.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw userError('OIDC id_token is malformed.', { code: 'OIDC_ID_TOKEN_MALFORMED' });
  }

  const publicKey = await importVerificationKey(params.header, params.key);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlDecode(encodedSignature);
  const verified =
    params.header.alg === 'ES256'
      ? await webcrypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          toArrayBuffer(signature),
          toArrayBuffer(signingInput)
        )
      : await webcrypto.subtle.verify(
          { name: 'RSASSA-PKCS1-v1_5' },
          publicKey,
          toArrayBuffer(signature),
          toArrayBuffer(signingInput)
        );

  if (!verified) {
    throwIdTokenValidation('OIDC id_token signature verification failed.');
  }
}

export async function validateOidcIdToken(
  idToken: string,
  metadata: OidcMetadata,
  options: {
    clientId: string;
    allowExpired?: boolean;
    nowMs?: number;
  }
): Promise<IdTokenClaims> {
  const header = decodeIdTokenHeader(idToken);
  const claims = decodeIdTokenClaims(idToken);
  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = 60_000;

  if (claims.issuer !== metadata.issuer) {
    throwIdTokenValidation('OIDC id_token issuer is not trusted.');
  }

  if (!claims.audience.includes(options.clientId)) {
    throwIdTokenValidation('OIDC id_token audience is not trusted.');
  }
  if (
    claims.authorizedParty !== undefined &&
    claims.authorizedParty !== options.clientId
  ) {
    throwIdTokenValidation('OIDC id_token is not authorized for this client.');
  }

  if (!options.allowExpired && claims.expiresAt + clockSkewMs <= nowMs) {
    throwIdTokenValidation('OIDC id_token is expired.');
  }
  if (claims.notBefore !== undefined && claims.notBefore - clockSkewMs > nowMs) {
    throwIdTokenValidation('OIDC id_token is not valid yet.');
  }

  let jwks = await getOidcJwks(metadata);
  let lookup = findJwksKeyByHeader(jwks.keys, header);
  if (lookup.kind === 'missing' && jwks.fromCache) {
    jwks = await getOidcJwks(metadata, { forceRefresh: true });
    lookup = findJwksKeyByHeader(jwks.keys, header);
  }
  if (lookup.kind === 'missing') {
    throwIdTokenValidation('OIDC id_token signing key was not found.');
  }
  await verifyIdTokenSignature({
    idToken,
    header,
    key: lookup.key,
  });

  return claims;
}

async function normalizeStoredSession(
  response: TokenResponse,
  metadata: OidcMetadata,
  clientId: string
): Promise<StoredOidcSession> {
  if (!response.id_token) {
    throw userError('Device authorization completed without an id_token.', {
      code: 'OIDC_ID_TOKEN_MISSING',
    });
  }

  const claims = await validateOidcIdToken(response.id_token, metadata, { clientId });
  return {
    idToken: response.id_token,
    refreshToken: response.refresh_token,
    accessToken: response.access_token,
    grantedScopes: normalizeOidcScopeList(response.scope),
    expiresAt: claims.expiresAt,
    createdAt: Date.now(),
  };
}

async function parseTokenResponse(response: Response): Promise<TokenResponse> {
  const json = await parseJsonResponse<TokenResponse>(response);
  if (!response.ok) {
    parseTokenError(json, response.statusText);
  }
  return json;
}

export async function requestDeviceAuthorization(params: {
  metadata: OidcMetadata;
  clientId: string;
  scope: string;
}): Promise<DeviceAuthorizationChallenge> {
  const response = await fetch(toDeviceEndpoint(params.metadata, 'device/code'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: params.clientId,
      scope: params.scope,
    }),
  });

  const payload = await parseJsonResponse<DeviceCodeResponse>(response);
  if (!response.ok || payload.error) {
    throw toDeviceStartError(response, payload);
  }

  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw connectivityError('Device authorization response is missing required fields.', {
      code: 'OIDC_DEVICE_RESPONSE_INVALID',
    });
  }

  const expiresInSeconds =
    parsePositiveNumber(payload.expires_in) ?? DEFAULT_DEVICE_EXPIRES_IN_SECONDS;
  const intervalSeconds =
    parsePositiveNumber(payload.interval) ?? DEFAULT_DEVICE_INTERVAL_SECONDS;

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    verificationUriComplete: payload.verification_uri_complete ?? null,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    intervalSeconds,
  };
}

export async function requestVerificationEmail(params: {
  metadata: OidcMetadata;
  email: string;
  callbackURL?: string;
}): Promise<void> {
  const response = await fetch(toDeviceEndpoint(params.metadata, 'send-verification-email'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      callbackURL: params.callbackURL,
    }),
  });

  const payload = await parseJsonResponse<VerificationEmailResponse>(response);
  if (!response.ok || payload.error || payload.status !== true) {
    throw toVerificationEmailError(response, payload);
  }
}

export async function pollDeviceAuthorization(params: {
  metadata: OidcMetadata;
  clientId: string;
  deviceCode: string;
  debug?: OidcDebugLogger;
}): Promise<DeviceTokenPollResult> {
  const requests = createOrderedDeviceTokenPollRequests(params);
  let previousAttempt:
    | {
        request: DeviceTokenPollRequest;
        response: Response;
        payload: TokenResponse;
      }
    | undefined;

  for (const [index, request] of requests.entries()) {
    const attempt = await fetchDeviceTokenPollResponse({
      request,
      debug: params.debug,
    });

    if (attempt.payload.error === 'authorization_pending') {
      return { kind: 'pending' };
    }

    if (attempt.payload.error === 'slow_down') {
      return { kind: 'slow_down' };
    }

    if (!attempt.payload.error && attempt.response.ok) {
      return {
        kind: 'success',
        session: await normalizeStoredSession(attempt.payload, params.metadata, params.clientId),
      };
    }

    const nextRequest = requests[index + 1];
    if (
      nextRequest &&
      canRetryDevicePollWithAlternateTransport({
        response: attempt.response,
        payload: attempt.payload,
      })
    ) {
      params.debug?.(
        `Device token exchange failed via ${describePollTransport(request.kind).toLowerCase()}; retrying with ${describePollTransport(nextRequest.kind).toLowerCase()} at ${nextRequest.url}`
      );
      previousAttempt = attempt;
      continue;
    }

    if (!attempt.payload.error) {
      const error = connectivityError(
        `Device authorization polling failed (${attempt.response.status}) via ${describePollTransport(attempt.request.kind).toLowerCase()}.`,
        {
          code: 'OIDC_DEVICE_POLL_FAILED',
        }
      );

      if (previousAttempt) {
        throw withPollContext(
          error,
          `current ${describePollTransport(attempt.request.kind).toLowerCase()} failed at ${attempt.request.url}; previous ${describePollTransport(previousAttempt.request.kind).toLowerCase()} attempt failed at ${previousAttempt.request.url}`
        );
      }

      throw withPollContext(
        error,
        `${describePollTransport(attempt.request.kind).toLowerCase()} failed at ${attempt.request.url}`
      );
    }

    const error = toDevicePollError(attempt.payload);
    if (previousAttempt) {
      throw withPollContext(
        error,
        `current ${describePollTransport(attempt.request.kind).toLowerCase()} failed at ${attempt.request.url}; previous ${describePollTransport(previousAttempt.request.kind).toLowerCase()} attempt failed at ${previousAttempt.request.url}`
      );
    }

    throw withPollContext(
      error,
      `${describePollTransport(attempt.request.kind).toLowerCase()} failed at ${attempt.request.url}`
    );
  }

  throw connectivityError('No device token polling transport is available.', {
    code: 'OIDC_DEVICE_POLL_FAILED',
  });
}

export async function waitForDeviceAuthorization(params: {
  metadata: OidcMetadata;
  clientId: string;
  deviceCode: string;
  intervalSeconds?: number;
  expiresAt?: number;
  sleep?: (ms: number) => Promise<void>;
  debug?: OidcDebugLogger;
}): Promise<StoredOidcSession> {
  const sleep = params.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let intervalSeconds = Math.max(
    1,
    params.intervalSeconds ?? DEFAULT_DEVICE_INTERVAL_SECONDS
  );
  const deadline = params.expiresAt ?? Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SECONDS * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    params.debug?.(
      `Device authorization poll attempt ${attempt} with interval ${intervalSeconds}s`
    );
    const result = await pollDeviceAuthorization({
      metadata: params.metadata,
      clientId: params.clientId,
      deviceCode: params.deviceCode,
      debug: params.debug,
    });

    if (result.kind === 'success') {
      return result.session;
    }

    if (result.kind === 'slow_down') {
      intervalSeconds += 5;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    params.debug?.(
      `Sleeping ${Math.min(intervalSeconds * 1000, remainingMs)}ms before the next device authorization poll`
    );
    await sleep(Math.min(intervalSeconds * 1000, remainingMs));
  }

  throw userError('The device authorization expired. Run `masumi-agent-messenger account login` again.', {
    code: 'OIDC_DEVICE_EXPIRED',
  });
}

export async function refreshStoredSession(params: {
  session: StoredOidcSession;
  metadata: OidcMetadata;
  clientId: string;
}): Promise<StoredOidcSession | null> {
  if (!params.session.refreshToken) {
    return null;
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', params.clientId);
  body.set('refresh_token', params.session.refreshToken);

  const response = await fetch(params.metadata.token_endpoint, {
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

  const normalized = await normalizeStoredSession(refreshed, params.metadata, params.clientId);
  return {
    ...normalized,
    grantedScopes:
      normalized.grantedScopes && normalized.grantedScopes.length > 0
        ? normalized.grantedScopes
        : params.session.grantedScopes ?? [],
    refreshToken: refreshed.refresh_token ?? params.session.refreshToken,
    accessToken: refreshed.access_token ?? params.session.accessToken,
    createdAt: params.session.createdAt,
  };
}

export function sessionNeedsRefresh(session: StoredOidcSession): boolean {
  return session.expiresAt - Date.now() <= SESSION_REFRESH_WINDOW_MS;
}
