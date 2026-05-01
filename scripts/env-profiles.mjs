// Profile definitions for `pnpm env:use <profile>`.
// Edit here to add or adjust dev environments.

export const PROFILES = {
  mainnet: {
    SPACETIMEDB_HOST: 'https://maincloud.spacetimedb.com',
    SPACETIMEDB_DB_NAME: 'masumi-agent-messenger-3rx0g',
    MASUMI_OIDC_ISSUER: 'https://app.masumi.network',
    MASUMI_NETWORK: 'Mainnet',
  },
  dev: {
    SPACETIMEDB_HOST: 'https://maincloud.spacetimedb.com',
    SPACETIMEDB_DB_NAME: 'masumi-messenger-dev-4f973',
    MASUMI_OIDC_ISSUER: 'https://masumi-saas-dev-exyyd.ondigitalocean.app',
    MASUMI_NETWORK: 'Preprod',
  },
  local: {
    SPACETIMEDB_HOST: 'ws://localhost:3000',
    SPACETIMEDB_DB_NAME: 'agentmessenger-dev',
    MASUMI_OIDC_ISSUER: 'http://localhost:2999',
    MASUMI_NETWORK: 'Preprod',
  },
};

const FRAMEWORK_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'REACT_APP_', 'EXPO_PUBLIC_', 'PUBLIC_'];
const MIRRORED_KEYS = ['SPACETIMEDB_HOST', 'SPACETIMEDB_DB_NAME'];

export function expandProfile(profile) {
  const expanded = { ...profile };
  for (const key of MIRRORED_KEYS) {
    const value = profile[key];
    if (value === undefined) continue;
    for (const prefix of FRAMEWORK_PREFIXES) {
      expanded[`${prefix}${key}`] = value;
    }
  }
  return expanded;
}

export function resolveSpacetimeServerAlias(host) {
  const trimmed = (host ?? '').trim();
  if (!trimmed) return { alias: 'maincloud', warning: null };
  if (/maincloud\.spacetimedb\.com/i.test(trimmed)) {
    return { alias: 'maincloud', warning: null };
  }
  if (/^(ws|wss|http|https):\/\/localhost(:|\/|$)/i.test(trimmed) || /^localhost(:|$)/i.test(trimmed)) {
    return { alias: 'local', warning: null };
  }
  return {
    alias: trimmed,
    warning: `Unknown SpacetimeDB host "${trimmed}"; using it as a literal --server alias. Configure it in your spacetime CLI if needed.`,
  };
}

export function profileNames() {
  return Object.keys(PROFILES);
}
