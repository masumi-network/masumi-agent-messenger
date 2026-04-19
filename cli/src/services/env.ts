import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GENERATED_MASUMI_OIDC_ISSUER,
  GENERATED_SPACETIMEDB_DB_NAME,
  GENERATED_SPACETIMEDB_HOST,
} from '../../../shared/generated-oidc-config';

export const DEFAULT_OIDC_ISSUER = GENERATED_MASUMI_OIDC_ISSUER;
export const DEFAULT_OIDC_CLIENT_ID = 'masumi-spacetime-cli';
export const DEFAULT_SPACETIMEDB_HOST = GENERATED_SPACETIMEDB_HOST;
export const DEFAULT_SPACETIMEDB_DB_NAME = GENERATED_SPACETIMEDB_DB_NAME;

/**
 * Resolve the OIDC clientId that should be used by the CLI.
 *
 * The webapp and CLI often share a `.env` file but each uses a separate
 * OAuth client (`MASUMI_OIDC_CLIENT_ID` for the browser flow,
 * `MASUMI_CLI_OIDC_CLIENT_ID` for the device-code flow). When the CLI
 * variable is unset we fall back to the built-in default; we never inherit
 * the webapp variable because a browser client cannot sign in via the CLI.
 */
export function resolveCliClientId(
  env: { MASUMI_CLI_OIDC_CLIENT_ID?: string } = process.env
): string {
  return env.MASUMI_CLI_OIDC_CLIENT_ID?.trim() || DEFAULT_OIDC_CLIENT_ID;
}

type MutableEnv = Record<string, string | undefined>;

export type EnsureCliEnvLoadedOptions = {
  cwd?: string;
  env?: MutableEnv;
};

let loadedDefaultEnv = false;

function resolveWorkspaceRoot(startDir: string): string {
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

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(filePath => path.resolve(filePath)))];
}

function stripInlineComment(value: string): string {
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

function parseEnvValue(rawValue: string): string {
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

export function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

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

function loadEnvFile(filePath: string, env: MutableEnv, protectedKeys: Set<string>): void {
  if (!existsSync(filePath)) {
    return;
  }

  const parsed = parseDotenv(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (protectedKeys.has(key)) {
      continue;
    }

    env[key] = value;
  }
}

export function ensureCliEnvLoaded(options: EnsureCliEnvLoadedOptions = {}): void {
  if (!options.cwd && !options.env && loadedDefaultEnv) {
    return;
  }

  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const protectedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  );

  const envFiles = uniquePaths([
    path.join(workspaceRoot, '.env'),
    path.join(workspaceRoot, '.env.local'),
    path.join(cwd, '.env'),
    path.join(cwd, '.env.local'),
  ]);

  for (const filePath of envFiles) {
    loadEnvFile(filePath, env, protectedKeys);
  }

  if (!options.cwd && !options.env) {
    loadedDefaultEnv = true;
  }
}
