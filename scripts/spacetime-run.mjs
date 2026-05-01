import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpacetimeServerAlias } from './env-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const ENV_PATH = path.join(WORKSPACE_ROOT, '.env');
const ENV_LOCAL_PATH = path.join(WORKSPACE_ROOT, '.env.local');

function parseDotenv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length) : line;
    const sepIdx = normalized.indexOf('=');
    if (sepIdx <= 0) continue;
    const key = normalized.slice(0, sepIdx).trim();
    if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)) continue;
    let value = normalized.slice(sepIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
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

function run(command, args, label) {
  process.stdout.write(`[spacetime:active] ${label}: ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: WORKSPACE_ROOT, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`Failed to spawn ${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited with code ${result.status}`);
}

function main() {
  const action = process.argv[2];
  const passthrough = process.argv.slice(3);

  if (!action || !['publish', 'reset'].includes(action)) {
    process.stderr.write('Usage: node scripts/spacetime-run.mjs <publish|reset> [extra spacetime args]\n');
    process.exit(1);
  }

  const env = loadEffectiveEnv();
  const host = env.SPACETIMEDB_HOST?.trim();
  const database = env.SPACETIMEDB_DB_NAME?.trim();

  if (!host || !database) {
    throw new Error('SPACETIMEDB_HOST and SPACETIMEDB_DB_NAME must be set in .env / .env.local');
  }

  const { alias, warning } = resolveSpacetimeServerAlias(host);
  if (warning) process.stdout.write(`[spacetime:active] warning: ${warning}\n`);

  process.stdout.write(`[spacetime:active] action=${action} server=${alias} database=${database}\n`);

  run(
    'node',
    [path.join(WORKSPACE_ROOT, 'scripts/prepare-spacetime-env.mjs'), '--action', action, '--server', alias, '--database', database],
    'prepare-env'
  );

  if (action === 'publish') {
    run(
      'spacetime',
      ['publish', '--module-path', 'spacetimedb', '--server', alias, database, ...passthrough],
      'publish'
    );
  } else {
    run(
      'spacetime',
      ['publish', '--module-path', 'spacetimedb', '--server', alias, database, '--delete-data=always', '-y', ...passthrough],
      'reset'
    );
  }

  run(
    'spacetime',
    ['generate', '--lang', 'typescript', '--out-dir', 'webapp/src/module_bindings', '--module-path', 'spacetimedb'],
    'generate'
  );
}

main();
