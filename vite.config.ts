import { defineConfig } from 'vitest/config';

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages serves the site under /sailing-school/; `vite preview` must serve the build at the same base.
  base: command === 'build' || isPreview ? '/sailing-school/' : '/',
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5180, strictPort: false },
  // Serve three's ESM files directly so addons and the app share ONE three instance.
  optimizeDeps: { exclude: ['three'] },
  // Many tests sail the real simulation for minutes of sim time; a busy machine or a CI runner needs headroom.
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 30_000 },
}));
