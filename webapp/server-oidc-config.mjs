function parseBooleanFlag(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeList(value) {
  if (!value) return [];

  const seen = new Set();
  const entries = [];
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

export function resolveServerOidcRuntimeConfig(env, generated) {
  const issuer = env.MASUMI_OIDC_ISSUER?.trim();
  const clientId = env.MASUMI_OIDC_CLIENT_ID?.trim();
  const audiences = normalizeList(env.MASUMI_OIDC_AUDIENCES);
  const hasExplicitValues = Boolean(
    issuer || clientId || env.MASUMI_OIDC_AUDIENCES?.trim()
  );

  if (hasExplicitValues) {
    const missing = [];
    if (!issuer) missing.push('MASUMI_OIDC_ISSUER');
    if (!clientId) missing.push('MASUMI_OIDC_CLIENT_ID');
    if (audiences.length === 0) missing.push('MASUMI_OIDC_AUDIENCES');
    if (missing.length > 0) {
      throw new Error(
        `Missing OIDC auth config: ${missing.join(', ')}. Configure all OIDC auth settings together.`
      );
    }

    return {
      issuer: issuer.replace(/\/+$/, ''),
      clientId,
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
