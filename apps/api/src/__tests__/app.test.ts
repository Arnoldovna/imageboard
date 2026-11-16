import type { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createFakeStorage, silentLogger } from '../../test/fakes.js';
import { problemOf } from '../../test/http.js';
import { createApp } from '../app.js';
import { type EnvKey, loadEnv } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { memoryRateLimitStores } from '../shared/security/security.js';

/**
 * The real app with in-memory stand-ins: no request below reaches Postgres (the pool connects lazily and nothing
 * queries it) or Redis (express-session's memory store, in-memory limiter stores). Integration tests cover the real
 * stores.
 */
function appWith(overrides: Partial<Record<EnvKey, string>> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:9/never-connected',
    REDIS_URL: 'redis://127.0.0.1:9',
    SESSION_SECRET: 'unit-session-secret-at-least-32-chars',
    CSRF_SECRET: 'unit-csrf-secret-at-least-32-characters',
    S3_BUCKET: 'unit-bucket',
    S3_ACCESS_KEY_ID: 'unit',
    S3_SECRET_ACCESS_KEY: 'unit',
    ...overrides,
  });
  const logger = silentLogger();
  return createApp({
    env,
    logger,
    db: createDatabase(env.DATABASE_URL, logger).db,
    storage: createFakeStorage(),
    session: session({ secret: env.SESSION_SECRET, resave: false, saveUninitialized: false }),
    rateLimitStores: memoryRateLimitStores,
    readiness: {},
    isShuttingDown: () => false,
  });
}

const postJson = (app: Express, body: string) =>
  request(app).post('/api/anything').set('Content-Type', 'application/json').send(body);

describe('createApp middleware order (OVERVIEW §4.1)', () => {
  it('F-40: malformed JSON bodies count against the global limiter (it runs before body parsing)', async () => {
    const app = appWith({ RATE_LIMIT_GLOBAL: '2' });

    expect(problemOf(await postJson(app, '{"broken": ')).code).toBe('malformed-request');
    expect((await postJson(app, '{"broken": ')).status).toBe(400);
    const limited = await postJson(app, '{"broken": ');

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('F-49: a JSON body over 16 KB is rejected with 413 problem+json', async () => {
    const response = await postJson(appWith(), JSON.stringify({ text: 'x'.repeat(16 * 1024) }));

    expect(response.status).toBe(413);
    expect(problemOf(response).code).toBe('payload-too-large');
  });

  it('F-47: health is not counted by the global limiter', async () => {
    const app = appWith({ RATE_LIMIT_GLOBAL: '1' });

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/health/live')).status).toBe(200);
    }
    expect((await request(app).get('/api/anything')).status).toBe(404);
  });

  it('F-47: paths are case-sensitive, so /api/HEALTH never reaches the internal health router', async () => {
    const app = appWith();

    // Mount paths (app setting) and the paths inside a router (`caseSensitive: true`) alike.
    for (const path of ['/api/HEALTH', '/api/Health/live', '/api/health/LIVE', '/api/media/IMAGES/a.jpg']) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(problemOf(response).code, path).toBe('not-found');
    }
    expect((await request(app).get('/api/health/live')).status).toBe(200);
  });

  it('B-03 / F-39: a mutation without a CSRF token is 403 csrf-invalid, before any route', async () => {
    const response = await postJson(appWith(), '{}');

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('csrf-invalid');
  });

  it('B-03: a cross-site mutation is 403 cross-origin-request before the CSRF check', async () => {
    const response = await request(appWith()).delete('/api/images/1').set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('cross-origin-request');
  });

  it('B-03: a cross-site mutation is refused before its body is parsed', async () => {
    const response = await postJson(appWith(), '{"broken": ').set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('cross-origin-request');
  });

  it('F-42: no HSTS when cookies are not Secure, even with NODE_ENV=production (the local compose stack)', async () => {
    const behindProxy = { NODE_ENV: 'production', TRUST_PROXY: '1' } as const;
    const local = await request(appWith({ ...behindProxy, COOKIE_SECURE: 'false' }))
      .get('/api/x')
      .set('X-Forwarded-Proto', 'https');
    const https = await request(appWith(behindProxy)).get('/api/x').set('X-Forwarded-Proto', 'https');
    const plainHttp = await request(appWith(behindProxy)).get('/api/x');

    expect(local.headers['strict-transport-security']).toBeUndefined();
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    // RFC 6797 §7.2: never over plain http, whatever the deployment says.
    expect(plainHttp.headers['strict-transport-security']).toBeUndefined();
  });

  it('B-10: never sends X-Powered-By and echoes a request id', async () => {
    const response = await request(appWith()).get('/api/anything');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('B-32: serves no static files, only problem+json 404s outside the routes', async () => {
    const response = await request(appWith()).get('/index.html');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
