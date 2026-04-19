const DEFAULT_INSECURE_DEV_SESSION_SECRET = 'masumi-dev-session-secret-change-me';

type EnvLike = Record<string, string | undefined>;
type OidcGeneratedConfig = {
  source: 'explicit' | 'local-default';
  issuer: string;
  clientId: string;
  audiences: string[];
};
type OidcRuntimeConfig = {
  issuer: string;
  clientId: string;
  audiences: string[];
};

export function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeList(value: string | undefined): string[] {
  if (!value) return [];

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const rawEntry of value.split(/[,\s]+/)) {
    const entry = rawEntry.trim();
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }

  return entries;
}

export function resolveSessionSecretFromEnv(env: EnvLike): string {
  const configured = env.MASUMI_SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }

  if (
    env.NODE_ENV !== 'production' &&
    parseBooleanFlag(env.MASUMI_ALLOW_INSECURE_DEV_SESSION_SECRET)
  ) {
    return DEFAULT_INSECURE_DEV_SESSION_SECRET;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('MASUMI_SESSION_SECRET is required in production');
  }

  throw new Error(
    'MASUMI_SESSION_SECRET is required. Set MASUMI_ALLOW_INSECURE_DEV_SESSION_SECRET=true only for isolated local testing.'
  );
}

export function resolveOidcRuntimeConfigFromEnv(
  env: EnvLike,
  generated: OidcGeneratedConfig
): OidcRuntimeConfig {
  const issuer = env.MASUMI_OIDC_ISSUER?.trim();
  const clientId = env.MASUMI_OIDC_CLIENT_ID?.trim();
  const audiences = normalizeList(env.MASUMI_OIDC_AUDIENCES);
  const hasExplicitValues = Boolean(
    issuer || clientId || env.MASUMI_OIDC_AUDIENCES?.trim()
  );

  if (hasExplicitValues) {
    const missing: string[] = [];
    if (!issuer) missing.push('MASUMI_OIDC_ISSUER');
    if (!clientId) missing.push('MASUMI_OIDC_CLIENT_ID');
    if (audiences.length === 0) missing.push('MASUMI_OIDC_AUDIENCES');
    if (missing.length > 0) {
      throw new Error(
        `Missing OIDC auth config: ${missing.join(', ')}. Configure all OIDC auth settings together.`
      );
    }

    return {
      issuer: issuer!.replace(/\/+$/, ''),
      clientId: clientId!,
      audiences,
    };
  }

  if (generated.source === 'explicit') {
    return {
      issuer: generated.issuer,
      clientId: generated.clientId,
      audiences: [...generated.audiences],
    };
  }

  if (parseBooleanFlag(env.MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG)) {
    return {
      issuer: generated.issuer,
      clientId: generated.clientId,
      audiences: [...generated.audiences],
    };
  }

  throw new Error(
    'OIDC auth config is required. Set MASUMI_OIDC_ISSUER, MASUMI_OIDC_CLIENT_ID, and MASUMI_OIDC_AUDIENCES together, or set MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true only for isolated local development.'
  );
}

export function buildDocumentCsp(_options: { isDev: boolean }): string {
  // The current SpacetimeDB web client generates deserializers with Function().
  // Keep document CSP aligned until that client path no longer requires eval.
  const scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    "connect-src 'self' ws: wss: http: https:",
    "worker-src 'self' blob:",
  ].join('; ');
}

export function appendStandardSecurityHeaders(
  headers: Headers,
  options: { includeDocumentCsp?: boolean; isDev?: boolean } = {}
): Headers {
  headers.set('Referrer-Policy', 'same-origin');
  headers.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()'
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (options.includeDocumentCsp) {
    headers.set('Content-Security-Policy', buildDocumentCsp({ isDev: Boolean(options.isDev) }));
  }
  return headers;
}

export function isSameOriginUnsafeRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) {
    return origin === requestUrl.origin;
  }

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === 'same-origin';
}

export function assertSameOriginUnsafeRequest(request: Request): void {
  if (!isSameOriginUnsafeRequest(request)) {
    throw new Error('Cross-site unsafe requests are not allowed');
  }
}
