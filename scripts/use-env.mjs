import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILES,
  expandProfile,
  profileNames,
  resolveSpacetimeServerAlias,
} from './env-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const ENV_LOCAL_PATH = path.join(WORKSPACE_ROOT, '.env.local');
const ENV_PATH = path.join(WORKSPACE_ROOT, '.env');
const SPACETIME_JSON_PATH = path.join(WORKSPACE_ROOT, 'spacetime.json');

const BLOCK_BEGIN = '# >>> masumi-env-profile';
const BLOCK_END = '# <<< masumi-env-profile';
const ACTIVE_HEADER_PREFIX = '# active profile:';

function parseDotenvLine(line) {
  const normalized = line.startsWith('export ') ? line.slice('export '.length) : line;
  const sepIdx = normalized.indexOf('=');
  if (sepIdx <= 0) return null;
  const key = normalized.slice(0, sepIdx).trim();
  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)) return null;
  let value = normalized.slice(sepIdx + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function parseDotenv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = parseDotenvLine(line);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
}

function loadEffectiveEnv() {
  const env = {};
  for (const file of [ENV_PATH, ENV_LOCAL_PATH]) {
    if (!existsSync(file)) continue;
    Object.assign(env, parseDotenv(readFileSync(file, 'utf8')));
  }
  return env;
}

function readActiveProfileName() {
  if (!existsSync(ENV_LOCAL_PATH)) return null;
  const lines = readFileSync(ENV_LOCAL_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(ACTIVE_HEADER_PREFIX)) {
      return line.slice(ACTIVE_HEADER_PREFIX.length).trim() || null;
    }
  }
  return null;
}

function stripExistingBlock(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock && line.startsWith(ACTIVE_HEADER_PREFIX)) continue;
    if (line.trim() === BLOCK_BEGIN) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    out.push(line);
  }
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

function quoteEnvValue(value) {
  if (/[\s#'"]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function writeEnvLocal(profileName, expanded) {
  const existing = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const preserved = stripExistingBlock(existing);

  const blockLines = [BLOCK_BEGIN];
  for (const [key, value] of Object.entries(expanded)) {
    blockLines.push(`${key}=${quoteEnvValue(value)}`);
  }
  blockLines.push(BLOCK_END);

  const sections = [`${ACTIVE_HEADER_PREFIX} ${profileName}`, blockLines.join('\n')];
  if (preserved.trim().length > 0) sections.push(preserved.trim());

  writeFileSync(ENV_LOCAL_PATH, `${sections.join('\n\n')}\n`, 'utf8');
}

function rewriteSpacetimeJson(host, databaseName) {
  if (!existsSync(SPACETIME_JSON_PATH)) {
    process.stdout.write(`[env:use] spacetime.json not found at ${SPACETIME_JSON_PATH}; skipping rewrite.\n`);
    return null;
  }
  const raw = readFileSync(SPACETIME_JSON_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse spacetime.json: ${err.message}`);
  }
  const { alias, warning } = resolveSpacetimeServerAlias(host);
  parsed.server = alias;
  parsed.database = databaseName;
  writeFileSync(SPACETIME_JSON_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { alias, warning };
}

function runChild(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw new Error(`[env:use] failed to spawn ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[env:use] ${label} exited with code ${result.status}`);
  }
}

function printStatus() {
  const env = loadEffectiveEnv();
  const activeName = readActiveProfileName();
  const host = env.SPACETIMEDB_HOST ?? '(unset)';
  const db = env.SPACETIMEDB_DB_NAME ?? '(unset)';
  const issuer = env.MASUMI_OIDC_ISSUER ?? '(unset)';
  const network = env.MASUMI_NETWORK ?? '(unset)';

  let spacetimeJsonInfo = '(missing)';
  if (existsSync(SPACETIME_JSON_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(SPACETIME_JSON_PATH, 'utf8'));
      spacetimeJsonInfo = `server=${parsed.server} database=${parsed.database}`;
    } catch (err) {
      spacetimeJsonInfo = `(unreadable: ${err.message})`;
    }
  }

  process.stdout.write(
    [
      `[env:status] profile=${activeName ?? '(unset / .env defaults)'}`,
      `  host=${host}`,
      `  db=${db}`,
      `  issuer=${issuer}`,
      `  network=${network}`,
      `  spacetime.json: ${spacetimeJsonInfo}`,
      '',
    ].join('\n')
  );
}

function usage() {
  return `Usage:
  pnpm env:use <profile>     # switch profile (writes .env.local + spacetime.json + regenerates)
  pnpm env:status            # print effective values

Available profiles: ${profileNames().join(', ')}
`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(usage());
    process.exit(1);
  }

  if (args[0] === '--status' || args[0] === 'status') {
    printStatus();
    return;
  }

  const profileName = args[0];
  const profile = PROFILES[profileName];
  if (!profile) {
    process.stderr.write(`[env:use] unknown profile "${profileName}". ${usage()}`);
    process.exit(1);
  }

  const expanded = expandProfile(profile);
  writeEnvLocal(profileName, expanded);
  process.stdout.write(`[env:use] wrote .env.local block for profile "${profileName}".\n`);

  const stRewrite = rewriteSpacetimeJson(profile.SPACETIMEDB_HOST, profile.SPACETIMEDB_DB_NAME);
  if (stRewrite) {
    process.stdout.write(
      `[env:use] rewrote spacetime.json: server=${stRewrite.alias} database=${profile.SPACETIMEDB_DB_NAME}\n`
    );
    if (stRewrite.warning) {
      process.stdout.write(`[env:use] warning: ${stRewrite.warning}\n`);
    }
  }

  runChild('node', [path.join(WORKSPACE_ROOT, 'scripts/prepare-spacetime-env.mjs'), '--action', 'prepare-env'], 'spacetime:prepare-env');

  runChild(
    'spacetime',
    ['generate', '--lang', 'typescript', '--out-dir', 'webapp/src/module_bindings', '--module-path', 'spacetimedb'],
    'spacetime generate'
  );

  process.stdout.write(
    [
      '',
      `[env:use] profile "${profileName}" active.`,
      `  host=${profile.SPACETIMEDB_HOST}`,
      `  db=${profile.SPACETIMEDB_DB_NAME}`,
      `  issuer=${profile.MASUMI_OIDC_ISSUER}`,
      `  network=${profile.MASUMI_NETWORK}`,
      '  Note: spacetime.json was modified — revert before committing if you do not want this pinned.',
      '',
    ].join('\n')
  );
}

main();
