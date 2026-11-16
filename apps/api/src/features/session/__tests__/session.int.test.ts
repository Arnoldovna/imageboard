import { SessionDto } from '@app/shared';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import {
  agentWithSession,
  problemOf,
  SESSION_COOKIE,
  sessionCookieLifetime,
  setCookie,
} from '../../../../test/http.js';
import { silentLogger } from '../../../../test/fakes.js';
import { connectRedis, type RedisClient } from '../../../shared/redis/redis.js';
import { createSessionMiddleware } from '../../../shared/security/session.js';
import { markSessionActive } from '../../../shared/session/actor.js';

const CSRF_COOKIE = 'imageboard.x-csrf-token';
const DAY_SECONDS = 24 * 60 * 60;

function expectLifetime(response: request.Response, seconds: number): void {
  const lifetime = sessionCookieLifetime(response);
  expect(lifetime).toBeGreaterThanOrEqual(seconds - 1);
  expect(lifetime).toBeLessThanOrEqual(seconds + 1);
}

describe('GET /api/session', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-34: creates a provisional anonymous session and returns the CSRF token and upload limit', async () => {
    const response = await request(testApp.app).get('/api/session');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body as object).sort()).toEqual(['csrfToken', 'uploadMaxBytes']);
    expect(SessionDto.parse(response.body).uploadMaxBytes).toBe(5 * 1024 * 1024);

    const sessionCookie = setCookie(response, SESSION_COOKIE);
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).not.toMatch(/Secure/);
    expectLifetime(response, DAY_SECONDS);
    expect(setCookie(response, CSRF_COOKIE)).toMatch(/HttpOnly/);
  });

  it('F-34: the cookie holds only the signed session id, never the owner id', async () => {
    const response = await request(testApp.app).get('/api/session');
    const value = decodeURIComponent(setCookie(response, SESSION_COOKIE)?.split(';')[0]?.split('=')[1] ?? '');

    expect(value).toMatch(/^s:[A-Za-z0-9_-]+\.[A-Za-z0-9+/]+$/);
    expect(JSON.stringify(response.body)).not.toMatch(/owner/i);
  });

  it('keeps the same session on later calls and returns a token that stays valid', async () => {
    const { agent, csrfToken } = await agentWithSession(testApp.app);
    const again = await agent.get('/api/session');

    expect(again.status).toBe(200);
    expect(SessionDto.parse(again.body).csrfToken).toBe(csrfToken);
    // rolling: the provisional lifetime is renewed, not upgraded, by browsing.
    expectLifetime(again, DAY_SECONDS);
  });

  it('F-39 / B-03: a mutation without the token is 403 csrf-invalid', async () => {
    const { agent } = await agentWithSession(testApp.app);
    const response = await agent.post('/api/comments').send({});

    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemOf(response).code).toBe('csrf-invalid');
  });

  it('F-39 / B-03: a token from another session is rejected', async () => {
    const { agent } = await agentWithSession(testApp.app);
    const other = await agentWithSession(testApp.app);
    const response = await agent.post('/api/comments').set('x-csrf-token', other.csrfToken).send({});

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('csrf-invalid');
  });

  it('F-39: a valid token passes the CSRF check (the stub route then answers 404)', async () => {
    const { agent, csrfToken } = await agentWithSession(testApp.app);
    const response = await agent.post('/api/nothing-here').set('x-csrf-token', csrfToken).send({});

    expect(response.status).toBe(404);
    expect(problemOf(response).code).toBe('not-found');
  });

  it('B-03: a cross-site request is refused even with a valid token', async () => {
    const { agent, csrfToken } = await agentWithSession(testApp.app);
    const response = await agent
      .post('/api/nothing-here')
      .set('x-csrf-token', csrfToken)
      .set('Sec-Fetch-Site', 'cross-site')
      .send({});

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('cross-origin-request');
  });

  it('B-03: a refused cross-site request never touches the session (no rolling renewal of its cookie)', async () => {
    const { agent } = await agentWithSession(testApp.app);
    const response = await agent.post('/api/comments').set('Sec-Fetch-Site', 'cross-site').send({});

    expect(response.status).toBe(403);
    expect(setCookie(response, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('identity limiter (ADR 0002, ADR 0013)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { RATE_LIMIT_IDENTITIES: '2' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-40: limits new identities per IP, but never counts an existing session', async () => {
    const existing = await agentWithSession(testApp.app);
    for (let i = 0; i < 3; i += 1) {
      expect((await existing.agent.get('/api/session')).status).toBe(200);
    }

    expect((await request(testApp.app).get('/api/session')).status).toBe(200);
    const limited = await request(testApp.app).get('/api/session');

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(problemOf(limited).code).toBe('rate-limited');
    expect(setCookie(limited, SESSION_COOKIE)).toBeUndefined();
    expect((await existing.agent.get('/api/session')).status).toBe(200);
  });
});

describe('session promotion against real Redis (markSessionActive)', () => {
  let redis: RedisClient;
  const prefix = `test-${crypto.randomUUID()}`;
  const lifetimes = { provisionalMs: DAY_SECONDS * 1000, fullMs: 180 * DAY_SECONDS * 1000 };

  /** The real session middleware plus two routes that stand in for "GET /api/session" and "first comment". */
  function promotionApp() {
    const app = express();
    app.use(
      createSessionMiddleware({
        redis,
        secret: 'test-session-secret-at-least-32-chars',
        secure: false,
        prefix,
        lifetimes,
      }),
    );
    app.use(cookieParser());
    app.get('/start', (req, res) => {
      req.session.ownerId = crypto.randomUUID();
      res.status(204).end();
    });
    app.post('/posted', (req, res) => {
      markSessionActive(req);
      res.status(201).end();
    });
    return app;
  }

  async function redisTtl(): Promise<number> {
    const [key] = await redis.keys(`${prefix}:sess:*`);
    if (key === undefined) throw new Error('no session key in Redis');
    return redis.ttl(key);
  }

  beforeAll(async () => {
    redis = await connectRedis(inject('redisUrl'), 'test', silentLogger());
  });

  afterAll(async () => {
    await redis.close();
  });

  it('F-34: cookie expiry and Redis TTL go from 24 hours to 180 days after the first post, and stay there', async () => {
    const agent = request.agent(promotionApp());

    const started = await agent.get('/start');
    expectLifetime(started, DAY_SECONDS);
    expect(await redisTtl()).toBeGreaterThan(DAY_SECONDS - 60);
    expect(await redisTtl()).toBeLessThanOrEqual(DAY_SECONDS);

    const promoted = await agent.post('/posted');
    expectLifetime(promoted, 180 * DAY_SECONDS);
    expect(await redisTtl()).toBeGreaterThan(179 * DAY_SECONDS);

    // rolling: later responses renew the full lifetime, they never fall back to the provisional one.
    const later = await agent.get('/anything-else');
    expectLifetime(later, 180 * DAY_SECONDS);
  });
});
