import { expect, test, type Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import { getSessionViaApi } from './support/api.ts';
import { getAsLoadBalancer, type ResponseHeader } from './support/stack.ts';

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

test('F-47: /api/health is not reachable from outside, in any letter case (nginx answers 404)', async ({ request }) => {
  for (const path of ['/api/health', '/api/health/live', '/api/HEALTH', '/api/Health/live', '/API/health']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("B-10: API responses carry only the API's own security headers, never a second copy of the page's", async ({
  request,
}) => {
  const response = await request.get('/api/images?limit=1');
  expect(response.status()).toBe(200);

  const values = (name: string): string[] =>
    response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === name)
      .map((header) => header.value);
  const csp = values('content-security-policy');
  expect(csp).toHaveLength(1);
  expect(csp[0]).toMatch(/^default-src 'none'/);
  for (const name of ['x-frame-options', 'x-content-type-options', 'referrer-policy']) {
    expect(values(name), name).toHaveLength(1);
  }
  expect(values('x-frame-options')).toEqual(['DENY']);
});

/** `HSTS_POLICY` in apps/api/src/shared/security/security.ts, which nginx repeats for the pages. */
const HSTS = 'max-age=31536000; includeSubDomains';
const OVER_HTTPS = { 'x-forwarded-proto': 'https' };

function hstsOf(headers: readonly ResponseHeader[]): string[] {
  return headers
    .filter((header) => header.name.toLowerCase() === 'strict-transport-security')
    .map((header) => header.value);
}

test('ADR 0019: a client that claims https over plain http gets no HSTS, and the API still sees http', async ({
  request,
  baseURL,
}) => {
  // Every request from outside the web container is an ordinary client (docker-compose.e2e.yml), as in production.
  expect(hstsOf((await request.get('/', { headers: OVER_HTTPS })).headersArray())).toEqual([]);

  // B-03 compares Origin with <scheme>://<Host>: only the http origin is the API's own, so the claim was dropped.
  const { csrfToken } = await getSessionViaApi(request);
  const host = new URL(baseURL ?? '').host;
  const post = (origin: string) =>
    request.post('/api/nothing-here', { headers: { ...OVER_HTTPS, origin, 'x-csrf-token': csrfToken }, data: {} });
  expect((await post(`http://${host}`)).status()).toBe(404);
  const claimed = await post(`https://${host}`);
  expect(claimed.status()).toBe(403);
  expect(((await claimed.json()) as { code?: unknown }).code).toBe('cross-origin-request');
});

test('F-42 / ADR 0019: HSTS when the load balancer reports https, exactly one copy on pages and API responses', async () => {
  expect(hstsOf(await getAsLoadBalancer('/'))).toEqual([]);
  expect(hstsOf(await getAsLoadBalancer('/', OVER_HTTPS))).toEqual([HSTS]);
  expect(hstsOf(await getAsLoadBalancer('/api/images?limit=1', OVER_HTTPS))).toEqual([HSTS]);
});

test('B-10: a response nginx generates itself under /api/ still carries the security headers', async ({ request }) => {
  // The /api/health 404 never reaches the API, so helmet adds nothing; nginx fills in its own headers, as it does for
  // its 413, 502 and 504 pages.
  const response = await request.get('/api/health');
  expect(response.status()).toBe(404);

  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
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
