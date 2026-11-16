import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the production images in the isolated compose project `imageboard-e2e`, started by
 * `pnpm test:e2e` (scripts/run-e2e.mjs), which also sets E2E_BASE_URL. There is deliberately no `webServer`: nothing
 * may silently reuse the dev or demo stack (ADR 0015, conventions §6). Phase-5 units run against `pnpm e2e:up`.
 */
const baseURL = process.env['E2E_BASE_URL'];
if (!baseURL) {
  throw new Error('E2E_BASE_URL is not set. Run `pnpm test:e2e`, or `pnpm e2e:up` and pass the URL it prints.');
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/readme-media.spec.ts'], // README media has its own config (portfolio-readme skill)
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // a flaky test is a failing test: fix the cause (quality-gate), never retry it green
  // One stack (one api, one nginx) serves every worker, and it runs on the same machine as the browsers. The default
  // (half the cores) oversubscribes it locally: WebKit then needs over 10 s to open a page and the two-scheme axe
  // checks run into the test timeout. Four workers keep the run fast without contention; CI runners have two cores.
  workers: process.env['CI'] ? 2 : 4,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    // Dialog and focus behaviour differ between engines: smoke and detail also run on WebKit (OVERVIEW §15).
    {
      name: 'webkit',
      testMatch: ['smoke.spec.ts', 'detail.spec.ts'],
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
