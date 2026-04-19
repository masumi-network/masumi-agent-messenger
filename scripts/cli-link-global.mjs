import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, '.pnpm-global', 'bin');
const cliDir = path.join(root, 'cli');

fs.mkdirSync(binDir, { recursive: true });

const env = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  npm_config_global_bin_dir: binDir,
};

const result = spawnSync('pnpm', ['link'], { cwd: cliDir, env, stdio: 'inherit', shell: false });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('');
console.log('Linked `masumi-agent-messenger` to this repo:');
console.log(`  ${path.join(binDir, 'masumi-agent-messenger')}`);
console.log('');
console.log('Add it to PATH in your shell (or use direnv):');
console.log(`  export PATH="${binDir}:$PATH"`);
