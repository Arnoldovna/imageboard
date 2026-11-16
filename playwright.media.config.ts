import { defineConfig, devices } from '@playwright/test';

import base from './playwright.config.ts';

/**
 * README media (portfolio-readme skill): screenshots and the upload clip in `docs/media/`, taken against the seeded
 * demo stack. Run `pnpm demo`, then `E2E_BASE_URL=<printed URL> pnpm media:readme`. Never part of `pnpm test:e2e`.
 */
export default defineConfig({
  ...base,
  testDir: './e2e',
  testMatch: 'readme-media.spec.ts',
  testIgnore: [],
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { ...base.use, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'media', use: { ...devices['Desktop Chrome'] } }],
});
