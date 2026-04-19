export const MASUMI_OIDC_STANDARD_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
] as const;

export const MASUMI_OIDC_API_SCOPES = [
  'agents:read:preprod',
  'agents:write:preprod',
  'agents:read:mainnet',
  'agents:write:mainnet',
  'inbox-agents:read:preprod',
  'inbox-agents:write:preprod',
  'inbox-agents:read:mainnet',
  'inbox-agents:write:mainnet',
  'credentials:read:preprod',
  'credentials:write:preprod',
  'credentials:read:mainnet',
  'credentials:write:mainnet',
  'activity:read:preprod',
  'activity:read:mainnet',
  'earnings:read:preprod',
  'earnings:read:mainnet',
  'dashboard:read:preprod',
  'dashboard:read:mainnet',
] as const;

export const DEFAULT_MASUMI_OIDC_SCOPES = [
  ...MASUMI_OIDC_STANDARD_SCOPES,
  ...MASUMI_OIDC_API_SCOPES,
] as const;

const REMOVED_MASUMI_OIDC_SCOPES = new Set(['account:read']);

export function normalizeOidcScopeList(
  input: Iterable<string> | string | null | undefined
): string[] {
  const rawValues =
    typeof input === 'string'
      ? input.split(/\s+/)
      : input
        ? Array.from(input)
        : [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawValue of rawValues) {
    const value = rawValue.trim();
    if (!value || REMOVED_MASUMI_OIDC_SCOPES.has(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function serializeOidcScopeList(scopes: Iterable<string>): string {
  return normalizeOidcScopeList(scopes).join(' ');
}

export function getMasumiOidcScopes(extraScopes?: string): string[] {
  return normalizeOidcScopeList([...DEFAULT_MASUMI_OIDC_SCOPES, ...normalizeOidcScopeList(extraScopes)]);
}

export function getMasumiOidcScopeString(extraScopes?: string): string {
  return serializeOidcScopeList(getMasumiOidcScopes(extraScopes));
}

export const DEFAULT_MASUMI_OIDC_SCOPE_STRING = getMasumiOidcScopeString();
