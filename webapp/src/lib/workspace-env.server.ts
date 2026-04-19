import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

function parseDotenv(content: string): Record<string, string> {
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

function loadEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  protectedKeys: Set<string>
): void {
  if (!existsSync(filePath)) return;

  const parsed = parseDotenv(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (protectedKeys.has(key)) continue;
    env[key] = value;
  }
}

export function ensureWorkspaceEnvLoaded(cwd = process.cwd()): void {
  if (loadedDefaultEnv) return;

  const env = process.env;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const protectedKeys = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
  );

  loadEnvFile(path.join(workspaceRoot, '.env'), env, protectedKeys);
  loadEnvFile(path.join(workspaceRoot, '.env.local'), env, protectedKeys);

  loadedDefaultEnv = true;
}
