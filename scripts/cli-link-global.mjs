import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, '.pnpm-global', 'bin');
const cliDir = path.join(root, 'cli');
const binName = 'masumi-agent-messenger';
const linkedBinPath = path.join(binDir, binName);

fs.mkdirSync(binDir, { recursive: true });
for (const staleBinPath of [
  linkedBinPath,
  `${linkedBinPath}.cmd`,
  `${linkedBinPath}.ps1`,
]) {
  fs.rmSync(staleBinPath, { force: true });
}

const env = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  npm_config_global_bin_dir: binDir,
};

const result = spawnSync('pnpm', ['link'], { cwd: cliDir, env, stdio: 'inherit', shell: false });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(linkedBinPath)) {
  console.error(`Expected linked CLI at ${linkedBinPath}, but pnpm did not create it.`);
  process.exit(1);
}

const currentPathBin = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter(Boolean)
  .map(pathEntry => path.join(pathEntry, binName))
  .find(candidate => fs.existsSync(candidate));

console.log('');
console.log('Linked `masumi-agent-messenger` to this repo:');
console.log(`  ${linkedBinPath}`);
console.log('');
console.log('Add it to PATH in your shell (or use direnv):');
console.log(`  export PATH="${binDir}:$PATH"`);
console.log('  hash -r');

if (currentPathBin && path.resolve(currentPathBin) !== linkedBinPath) {
  console.log('');
  console.log('A different install is currently first on PATH:');
  console.log(`  ${currentPathBin}`);
  console.log('Prepend the repo bin path above so this checkout wins.');
}
