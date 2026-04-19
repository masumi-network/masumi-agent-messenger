import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function resolveSpecPath() {
  const envPath = process.env.MASUMI_OPENAPI_SPEC?.trim();
  if (envPath) {
    return path.resolve(repoRoot, envPath);
  }

  return path.resolve(
    repoRoot,
    '../masumi-saas/apps/web/src/lib/swagger/openapi-platform-docs.json'
  );
}

function resolveGeneratorCli() {
  const envPath = process.env.MASUMI_OPENAPI_GENERATOR?.trim();
  if (envPath) {
    return path.resolve(repoRoot, envPath);
  }

  const localCli = path.resolve(
    repoRoot,
    'node_modules/openapi-typescript/bin/cli.js'
  );
  if (existsSync(localCli)) {
    return localCli;
  }

  const siblingPnpmDir = path.resolve(repoRoot, '../masumi-saas/node_modules/.pnpm');
  if (existsSync(siblingPnpmDir)) {
    const match = readdirSync(siblingPnpmDir).find(entry =>
      entry.startsWith('openapi-typescript@')
    );
    if (match) {
      const cliPath = path.join(
        siblingPnpmDir,
        match,
        'node_modules/openapi-typescript/bin/cli.js'
      );
      if (existsSync(cliPath)) {
        return cliPath;
      }
    }
  }

  throw new Error(
    'Unable to locate openapi-typescript. Install it locally or set MASUMI_OPENAPI_GENERATOR.'
  );
}

function main() {
  const specPath = resolveSpecPath();
  if (!existsSync(specPath)) {
    throw new Error(
      `Masumi OpenAPI spec not found at ${specPath}. Set MASUMI_OPENAPI_SPEC to override.`
    );
  }

  const outputPath = path.resolve(repoRoot, 'shared/generated-masumi-openapi.d.ts');
  const cliPath = resolveGeneratorCli();

  execFileSync(process.execPath, [cliPath, specPath, '-o', outputPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

main();
