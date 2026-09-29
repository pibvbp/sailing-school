import { defineConfig } from 'vitest/config';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sailing-school/' : '/',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5180, strictPort: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
