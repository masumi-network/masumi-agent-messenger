import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Keep in sync with shared/masumi-default-oidc-issuer.ts (MASUMI_DEFAULT_OIDC_ISSUER).
const DEFAULT_OIDC_ISSUER = 'https://masumi-saas-dev-exyyd.ondigitalocean.app';
const DEFAULT_OIDC_CLIENT_ID = 'masumi-spacetime-web';
const DEFAULT_OIDC_AUDIENCES = ['masumi-spacetime-web', 'masumi-spacetime-cli'];
const DEFAULT_SPACETIMEDB_HOST = 'wss://maincloud.spacetimedb.com';
const DEFAULT_SPACETIMEDB_DB_NAME = 'masumi-agent-messenger-3rx0g';
const LEGACY_SPACETIMEDB_DB_NAME_ALIASES = new Set([
  'agentmessenger',
  'agentmessenger-dev',
  'agent-messenger',
  'agent-messenger-dev',
]);
const GENERATED_TS_FILE = path.resolve(
  process.cwd(),
  'shared/generated-oidc-config.ts'
);
const GENERATED_MJS_FILE = path.resolve(
  process.cwd(),
  'shared/generated-oidc-config.mjs'
);

function readCliOption(name) {
  const option = `--${name}`;
  const index = process.argv.indexOf(option);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function resolveWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    if (
      existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
      existsSync(path.join(current, '.git'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }

    current = parent;
  }
}

function stripInlineComment(value) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === '#' && !inSingleQuote && !inDoubleQuote) {
      const previous = index === 0 ? '' : value[index - 1];
      if (previous === '' || /\s/.test(previous)) {
        return value.slice(0, index).trimEnd();
      }
    }
  }

  return value.trimEnd();
}

function parseEnvValue(rawValue) {
  const value = stripInlineComment(rawValue.trim());

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }

  return value;
}

function parseBooleanFlag(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeList(value) {
  if (!value) return [];

  const seen = new Set();
  const normalized = [];
  for (const rawEntry of value.split(/[,\s]+/)) {
    const entry = rawEntry.trim();
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    normalized.push(entry);
  }

  return normalized;
}

function parseDotenv(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice('export '.length) : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)) continue;

    values[key] = parseEnvValue(normalized.slice(separatorIndex + 1));
  }

  return values;
}

function loadWorkspaceEnv(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const env = { ...process.env };
  const protectedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  );
  const envSources = new Map(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => [key, 'process environment'])
  );

  for (const [fileLabel, filePath] of [
    ['.env', path.join(workspaceRoot, '.env')],
    ['.env.local', path.join(workspaceRoot, '.env.local')],
  ]) {
    if (!existsSync(filePath)) continue;
    const parsed = parseDotenv(readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (protectedKeys.has(key)) continue;
      env[key] = value;
      envSources.set(key, fileLabel);
    }
  }

  return { env, envSources };
}

function resolveMasumiNetwork(env) {
  const raw = env.MASUMI_NETWORK?.trim();
  if (!raw) return 'Preprod';
  const cap = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (cap === 'Preprod' || cap === 'Mainnet') return cap;
  throw new Error(`MASUMI_NETWORK must be 'Preprod' or 'Mainnet', got: ${raw}`);
}

function resolveOidcConfig(env) {
  const explicitIssuer = env.MASUMI_OIDC_ISSUER?.trim();
  const explicitClientId = env.MASUMI_OIDC_CLIENT_ID?.trim();
  const explicitAudiences = normalizeList(env.MASUMI_OIDC_AUDIENCES);
  const hasExplicitValues = Boolean(
    explicitIssuer || explicitClientId || env.MASUMI_OIDC_AUDIENCES?.trim()
  );

  if (hasExplicitValues) {
    const missing = [];
    if (!explicitIssuer) missing.push('MASUMI_OIDC_ISSUER');
    if (!explicitClientId) missing.push('MASUMI_OIDC_CLIENT_ID');
    if (explicitAudiences.length === 0) missing.push('MASUMI_OIDC_AUDIENCES');
    if (missing.length > 0) {
      throw new Error(
        `Missing OIDC auth config: ${missing.join(', ')}. Configure all OIDC auth settings together.`
      );
    }

    return {
      source: 'explicit',
      issuer: explicitIssuer.replace(/\/+$/, ''),
      clientId: explicitClientId,
      audiences: explicitAudiences,
    };
  }

  if (!parseBooleanFlag(env.MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG)) {
    throw new Error(
      'OIDC auth config is required. Set MASUMI_OIDC_ISSUER, MASUMI_OIDC_CLIENT_ID, and MASUMI_OIDC_AUDIENCES together, or set MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true only for isolated local development.'
    );
  }

  return {
    source: 'local-default',
    issuer: DEFAULT_OIDC_ISSUER,
    clientId: DEFAULT_OIDC_CLIENT_ID,
    audiences: [...DEFAULT_OIDC_AUDIENCES],
  };
}

function canonicalizeSpacetimeDbName(databaseName) {
  const trimmed = databaseName.trim();
  return LEGACY_SPACETIMEDB_DB_NAME_ALIASES.has(trimmed)
    ? DEFAULT_SPACETIMEDB_DB_NAME
    : trimmed;
}

function resolveSpacetimeConfig(env) {
  return {
    host: env.SPACETIMEDB_HOST?.trim() || DEFAULT_SPACETIMEDB_HOST,
    databaseName: canonicalizeSpacetimeDbName(
      env.SPACETIMEDB_DB_NAME?.trim() || DEFAULT_SPACETIMEDB_DB_NAME
    ),
  };
}

function buildGeneratedTsFile(config) {
  return `// This file is generated by scripts/prepare-spacetime-env.mjs.\n// Re-run \`pnpm run spacetime:prepare-env\` after changing MASUMI_OIDC_ISSUER, MASUMI_OIDC_CLIENT_ID, MASUMI_OIDC_AUDIENCES, MASUMI_NETWORK, SPACETIMEDB_HOST, or SPACETIMEDB_DB_NAME.\n\nexport const GENERATED_OIDC_CONFIG_SOURCE = ${JSON.stringify(config.source)} as const;\nexport const GENERATED_MASUMI_OIDC_ISSUER = ${JSON.stringify(config.issuer)};\nexport const GENERATED_MASUMI_OIDC_CLIENT_ID = ${JSON.stringify(config.clientId)};\nexport const GENERATED_MASUMI_OIDC_AUDIENCES = ${JSON.stringify(config.audiences, null, 2)} as const;\nexport const TRUSTED_OIDC_ISSUERS = new Set([GENERATED_MASUMI_OIDC_ISSUER]);\nexport const TRUSTED_OIDC_AUDIENCES = new Set([...GENERATED_MASUMI_OIDC_AUDIENCES]);\nexport const GENERATED_MASUMI_NETWORK = ${JSON.stringify(config.network)} as "Preprod" | "Mainnet";\nexport const GENERATED_SPACETIMEDB_HOST = ${JSON.stringify(config.spacetime.host)};\nexport const GENERATED_SPACETIMEDB_DB_NAME = ${JSON.stringify(config.spacetime.databaseName)};\n`;
}

function buildGeneratedMjsFile(config) {
  return `// This file is generated by scripts/prepare-spacetime-env.mjs.\n// Re-run \`pnpm run spacetime:prepare-env\` after changing MASUMI_OIDC_ISSUER, MASUMI_OIDC_CLIENT_ID, MASUMI_OIDC_AUDIENCES, MASUMI_NETWORK, SPACETIMEDB_HOST, or SPACETIMEDB_DB_NAME.\n\nexport const GENERATED_OIDC_CONFIG_SOURCE = ${JSON.stringify(config.source)};\nexport const GENERATED_MASUMI_OIDC_ISSUER = ${JSON.stringify(config.issuer)};\nexport const GENERATED_MASUMI_OIDC_CLIENT_ID = ${JSON.stringify(config.clientId)};\nexport const GENERATED_MASUMI_OIDC_AUDIENCES = ${JSON.stringify(config.audiences, null, 2)};\nexport const TRUSTED_OIDC_ISSUERS = new Set([GENERATED_MASUMI_OIDC_ISSUER]);\nexport const TRUSTED_OIDC_AUDIENCES = new Set([...GENERATED_MASUMI_OIDC_AUDIENCES]);\nexport const GENERATED_MASUMI_NETWORK = ${JSON.stringify(config.network)};\nexport const GENERATED_SPACETIMEDB_HOST = ${JSON.stringify(config.spacetime.host)};\nexport const GENERATED_SPACETIMEDB_DB_NAME = ${JSON.stringify(config.spacetime.databaseName)};\n`;
}

const action = readCliOption('action') ?? 'prepare-env';
const server = readCliOption('server');
const database = readCliOption('database');
const { env, envSources } = loadWorkspaceEnv(process.cwd());
const resolvedMasumiNetwork = resolveMasumiNetwork(env);
const resolvedSpacetimeConfig = resolveSpacetimeConfig(env);
const resolvedOidcConfig = {
  ...resolveOidcConfig(env),
  network: resolvedMasumiNetwork,
  spacetime: resolvedSpacetimeConfig,
};
const oidcSourceSummary =
  resolvedOidcConfig.source === 'explicit'
    ? [
        `issuer=${envSources.get('MASUMI_OIDC_ISSUER') ?? 'process environment'}`,
        `client=${envSources.get('MASUMI_OIDC_CLIENT_ID') ?? 'process environment'}`,
        `audiences=${envSources.get('MASUMI_OIDC_AUDIENCES') ?? 'process environment'}`,
      ].join(', ')
    : 'local default (MASUMI_ALLOW_DEFAULT_LOCAL_OIDC_CONFIG=true)';
const generatedFiles = [
  [GENERATED_TS_FILE, buildGeneratedTsFile(resolvedOidcConfig)],
  [GENERATED_MJS_FILE, buildGeneratedMjsFile(resolvedOidcConfig)],
];

for (const [filePath, nextContent] of generatedFiles) {
  const currentContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  if (currentContent !== nextContent) {
    writeFileSync(filePath, nextContent, 'utf8');
  }
}

const scopeSuffix =
  server || database
    ? ` (${[
        server ? `server=${server}` : null,
        database ? `database=${database}` : null,
      ]
        .filter(Boolean)
        .join(', ')})`
    : '';

process.stdout.write(
  `[spacetime:${action}] Using MASUMI_OIDC_ISSUER=${resolvedOidcConfig.issuer}, ` +
    `MASUMI_OIDC_CLIENT_ID=${resolvedOidcConfig.clientId}, ` +
    `MASUMI_OIDC_AUDIENCES=${resolvedOidcConfig.audiences.join(',')} ` +
    `SPACETIMEDB_HOST=${resolvedSpacetimeConfig.host}, ` +
    `SPACETIMEDB_DB_NAME=${resolvedSpacetimeConfig.databaseName} ` +
    `(source: ${oidcSourceSummary})${scopeSuffix}\n`
);
