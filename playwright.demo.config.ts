import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test of the static live demo (PLAN Etappe 3b) against the built `apps/web/dist-demo`, served by `vite preview`
 * under the GitHub Pages base path. Unlike `playwright.config.ts` there is no stack to isolate: the API runs in the
 * page (MSW + IndexedDB), and every test gets a fresh browser context, so a fresh demo database.
 *
 * Run `pnpm build:demo` first, then `pnpm test:demo`. DEMO_PORT overrides the preview port (default 4174).
 */
const port = Number(process.env['DEMO_PORT'] ?? '4174');
const baseURL = `http://127.0.0.1:${String(port)}/imageboard/`;

export default defineConfig({
  testDir: './e2e-demo',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // a flaky test is a failing test (quality-gate)
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --filter @app/web preview:demo --host 127.0.0.1 --port ${String(port)}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
