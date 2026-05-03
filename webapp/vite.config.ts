import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webappRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(webappRoot, '..');

function resolvePublicChannelSlugEnv(mode: string): string {
  const webappEnv = loadEnv(mode, webappRoot, ['VITE_', 'PUBLIC_']);
  const workspaceEnv = loadEnv(mode, workspaceRoot, ['VITE_', 'PUBLIC_']);
  return (
    process.env.VITE_PUBLIC_CHANNEL_SLUG ??
    webappEnv.VITE_PUBLIC_CHANNEL_SLUG ??
    workspaceEnv.VITE_PUBLIC_CHANNEL_SLUG ??
    process.env.PUBLIC_CHANNEL_SLUG ??
    webappEnv.PUBLIC_CHANNEL_SLUG ??
    workspaceEnv.PUBLIC_CHANNEL_SLUG ??
    ''
  );
}

export default defineConfig(({ mode }) => ({
  define: {
    'import.meta.env.VITE_PUBLIC_CHANNEL_SLUG': JSON.stringify(
      resolvePublicChannelSlugEnv(mode)
    ),
  },
  server: {
    port: 5173,
  },
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
    tsconfigPaths: true,
  },
  plugins: [
    tanstackStart(),
    react(),
  ],
  test: {
    environment: 'node',
    include: ['tests/security/**/*.test.ts'],
  },
}));
