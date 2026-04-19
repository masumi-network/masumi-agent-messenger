import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.tsx', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  dts: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
