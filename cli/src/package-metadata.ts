import { createRequire } from 'node:module';

type PackageJson = {
  version?: unknown;
  bin?: unknown;
};

const require = createRequire(import.meta.url);

function loadPackageJson(): PackageJson {
  return require('../package.json') as PackageJson;
}

function resolveBinName(bin: unknown): string | null {
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) {
    return null;
  }

  const binNames = Object.keys(bin);
  return binNames.length === 1 ? binNames[0] ?? null : null;
}

const packageJson = loadPackageJson();

export const CLI_BINARY_NAME = resolveBinName(packageJson.bin) ?? 'masumi-agent-messenger';
export const CLI_VERSION =
  typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
