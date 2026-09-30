// End-to-end smoke tests (plan Task 20) against the production build served by `vite preview`.
// Locally Chromium renders through Metal; in CI (no GPU) it falls back to SwiftShader.
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}/sailing-school/`;
const gpuArgs = CI
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1280, height: 720 }, launchOptions: { args: gpuArgs } },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE,
    reuseExistingServer: !CI,
    timeout: 240_000,
  },
});
