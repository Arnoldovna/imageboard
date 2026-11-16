import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import { getSessionViaApi } from './support/api.ts';

/** Collects CSP violations, which Chromium and WebKit report on the console ("Refused to load …"). */
function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to (load|apply|execute|connect)/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (/content security policy/i.test(error.message)) violations.push(error.message);
  });
  return violations;
}

test('F-42: home page renders with the wordmark under a strict CSP and no CSP violations', async ({ page }) => {
  const violations = collectCspViolations(page);

  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');

  await expect(page).toHaveTitle('Imageboard');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'imageboard' })).toBeVisible();
  // The self-hosted OFL face is allowed by the CSP and actually loads (weight 500 is used by the wordmark).
  const loadedFaces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.status === 'loaded')
      .map((face) => `${face.family.replaceAll('"', '')} ${face.weight}`);
  });
  expect(loadedFaces).toContain('Schibsted Grotesk 500');
  expect(violations).toEqual([]);
});

test('F-47: /api/health is not reachable from outside (nginx answers 404)', async ({ request }) => {
  for (const path of ['/api/health', '/api/health/live']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test('B-03: behind nginx, Origin alone (no Sec-Fetch-Site) passes for this origin and fails for another', async ({
  request,
  baseURL,
}) => {
  // Browsers without Fetch Metadata send only Origin; the API compares it with <scheme>://<Host> as nginx forwards it.
  const { csrfToken } = await getSessionViaApi(request);
  const origin = new URL(baseURL ?? '').origin;

  const own = await request.post('/api/nothing-here', { headers: { origin, 'x-csrf-token': csrfToken }, data: {} });
  expect(own.status()).toBe(404);

  const foreign = await request.post('/api/nothing-here', {
    headers: { origin: 'https://evil.test', 'x-csrf-token': csrfToken },
    data: {},
  });
  expect(foreign.status()).toBe(403);
  expect(((await foreign.json()) as { code?: unknown }).code).toBe('cross-origin-request');
});

test('hashed assets are immutable, but a missing asset is a 404 that is never cached as immutable', async ({
  request,
}) => {
  const html = await (await request.get('/')).text();
  const script = /\/assets\/[\w.-]+\.js/.exec(html)?.[0];
  expect(script, 'index.html references a hashed script').toBeDefined();

  const asset = await request.get(script!);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');

  const missing = await request.get('/assets/index-does-not-exist.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable');
});

test('home page is accessible', async ({ page }) => {
  await page.goto('/');
  await expectNoA11yViolations(page);
});

test('dark mode is accessible', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expectNoA11yViolations(page);
});
