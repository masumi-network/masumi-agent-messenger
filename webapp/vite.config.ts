import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
});
