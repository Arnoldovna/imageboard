import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setCookie } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/** F-42 (API side) and B-10. The SPA's CSP is set by nginx and asserted in e2e/smoke.spec.ts. */
describe('security headers on API responses', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it.each([
    ['a JSON response', '/api/session'],
    ['a problem response', '/api/does-not-exist'],
  ])('F-42 / B-10: %s carries the strict API headers', async (_case, path) => {
    const response = await request(testApp.app).get(path);

    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('F-42: no HSTS outside production (a local http stack must not pin it)', async () => {
    expect((await request(testApp.app).get('/api/session')).headers['strict-transport-security']).toBeUndefined();
  });

  it('ADR 0003: no CORS preflight support (same origin only)', async () => {
    const response = await request(testApp.app)
      .options('/api/session')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('production cookies behind a TLS-terminating proxy (ADR 0019)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { NODE_ENV: 'production', TRUST_PROXY: '1' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-34 / F-42: sets __Host- cookies with Secure when X-Forwarded-Proto: https arrives through the trusted hop', async () => {
    const response = await request(testApp.app).get('/api/session').set('X-Forwarded-Proto', 'https');

    expect(response.status).toBe(200);
    expect(setCookie(response, '__Host-imageboard.sid')).toMatch(/; Secure/);
    expect(setCookie(response, '__Host-imageboard.x-csrf-token')).toMatch(/; Secure/);
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('never sends the secure session cookie or HSTS over plain http', async () => {
    const response = await request(testApp.app).get('/api/session');

    expect(setCookie(response, '__Host-imageboard.sid')).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
