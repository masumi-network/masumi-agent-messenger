import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES } from './env-profiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const SPACETIME_JSON_PATH = path.join(WORKSPACE_ROOT, 'spacetime.json');

const mainnet = PROFILES.mainnet;
const expectedServer = 'maincloud';
const expectedDatabase = mainnet.SPACETIMEDB_DB_NAME;

if (!existsSync(SPACETIME_JSON_PATH)) {
  process.stderr.write('[pre-commit] spacetime.json missing — refusing to commit.\n');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(SPACETIME_JSON_PATH, 'utf8'));
} catch (err) {
  process.stderr.write(`[pre-commit] spacetime.json is not valid JSON: ${err.message}\n`);
  process.exit(1);
}

const actualServer = parsed.server;
const actualDatabase = parsed.database;

if (actualServer !== expectedServer || actualDatabase !== expectedDatabase) {
  process.stderr.write(
    [
      '[pre-commit] spacetime.json is not pinned to mainnet — refusing to commit.',
      `  expected: server=${expectedServer} database=${expectedDatabase}`,
      `  actual:   server=${actualServer} database=${actualDatabase}`,
      '',
      '  Run `pnpm env:mainnet` to flip back, then re-stage and re-commit.',
      '  (To bypass for an emergency commit: git commit --no-verify)',
      '',
    ].join('\n')
  );
  process.exit(1);
}

process.exit(0);
