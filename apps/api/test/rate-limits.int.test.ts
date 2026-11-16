import { CommentDto, CommentPage, ImageDto, SessionDto } from '@app/shared';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import type { EnvKey } from '../src/config/env.js';
import { createFakeStorage, type FakeStorage } from './fakes.js';
import { png } from './fixtures.js';
import { problemOf, setCookie, type SessionAgent } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';

/*
 * F-40 / B-09 (ADR 0013): every limiter of the app, each with a budget of 2 in its own app (fresh Redis prefix), all
 * others raised. The third request is `429 rate-limited` problem+json with `Retry-After` and the limiter's own
 * `RateLimit-Policy` (quota and window). Clients are told apart through `X-Forwarded-For` with TRUST_PROXY=1, which
 * is how the API sees them behind nginx.
 */

const LIMIT = 2;

/** Windows from ADR 0013, in seconds (the budgets come from the environment, the windows are fixed in code). */
const WINDOW_SECONDS = {
  global: 5 * 60,
  media: 5 * 60,
  identities: 60 * 60,
  uploads: 60 * 60,
  uploadsGlobalDay: 24 * 60 * 60,
  comments: 10 * 60,
  deletes: 10 * 60,
} as const;

const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.20';
const CLIENT_C = '192.0.2.30';
const UNKNOWN_MEDIA = '/api/media/images/0b9d3c2a-5e6f-4a1b-8c2d-3e4f5a6b7c8d.jpg';

const apps: TestApp[] = [];

afterAll(async () => {
  await Promise.all(apps.map((testApp) => testApp.close()));
});

async function appWith(env: Partial<Record<EnvKey, string>>, storage?: FakeStorage): Promise<TestApp> {
  const testApp = await createTestApp({ env: { TRUST_PROXY: '1', ...env }, ...(storage ? { storage } : {}) });
  apps.push(testApp);
  return testApp;
}

/** `agentWithSession` (test/http.ts) for one client address; later requests of this agent send the same address. */
async function sessionFrom(testApp: TestApp, ip: string): Promise<SessionAgent> {
  const agent = request.agent(testApp.app);
  const response = await agent.get('/api/session').set('X-Forwarded-For', ip);
  if (response.status !== 200) throw new Error(`GET /api/session answered ${String(response.status)}`);
  return { agent, csrfToken: SessionDto.parse(response.body).csrfToken };
}

function postImage({ agent, csrfToken }: SessionAgent, ip: string) {
  return agent
    .post('/api/images')
    .set('X-Forwarded-For', ip)
    .set('x-csrf-token', csrfToken)
    .field('authorName', 'Kofi')
    .field('title', 'Commute, the long way round')
    .attach('file', png(), { filename: 'ride.png', contentType: 'image/png' });
}

function postComment({ agent, csrfToken }: SessionAgent, ip: string, imageId: number) {
  return agent
    .post(`/api/images/${String(imageId)}/comments`)
    .set('X-Forwarded-For', ip)
    .set('x-csrf-token', csrfToken)
    .send({ authorName: 'Dariusz', body: 'Best kind of detour.' });
}

/** The 429 contract: problem+json, `Retry-After` within the window, and this limiter's policy (q=2, its window). */
function expectLimited(response: request.Response, windowSeconds: number): void {
  expect(response.status).toBe(429);
  expect(problemOf(response)).toMatchObject({ status: 429, code: 'rate-limited', title: 'Too many requests' });
  const retryAfter = Number(response.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  expect(String(response.headers['ratelimit-policy'])).toContain(`q=${String(LIMIT)}; w=${String(windowSeconds)};`);
}

describe('global limiter (RATE_LIMIT_GLOBAL, 300 / 5 min / IP)', () => {
  it('F-40 / B-09: every /api request counts; the third in the window is 429', async () => {
    const testApp = await appWith({ RATE_LIMIT_GLOBAL: String(LIMIT) });
    const client = request(testApp.app);

    expect((await client.get('/api/images').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
    expect((await client.get('/api/images/2147483647').set('X-Forwarded-For', CLIENT_A)).status).toBe(404);
    const limited = await client.get('/api/images').set('X-Forwarded-For', CLIENT_A);

    expectLimited(limited, WINDOW_SECONDS.global);
    // The budget is per client address.
    expect((await client.get('/api/images').set('X-Forwarded-For', CLIENT_B)).status).toBe(200);
  });

  it('ADR 0013: counted before the body is read: malformed JSON uses up the budget, then 429 instead of 400', async () => {
    const testApp = await appWith({ RATE_LIMIT_GLOBAL: String(LIMIT) });
    const sendBroken = () =>
      request(testApp.app)
        .post('/api/images/1/comments')
        .set('X-Forwarded-For', CLIENT_A)
        .set('Content-Type', 'application/json')
        .send('{"authorName":');

    expect((await sendBroken()).status).toBe(400);
    expect((await sendBroken()).status).toBe(400);

    expectLimited(await sendBroken(), WINDOW_SECONDS.global);
  });

  it('F-40: health and media are outside the global budget', async () => {
    const testApp = await appWith({ RATE_LIMIT_GLOBAL: String(LIMIT) });
    const client = request(testApp.app);

    for (let i = 0; i < LIMIT + 3; i += 1) {
      expect((await client.get('/api/health').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
      expect((await client.get(UNKNOWN_MEDIA).set('X-Forwarded-For', CLIENT_A)).status).toBe(404);
    }

    expect((await client.get('/api/images').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
    expect((await client.get('/api/images').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
    expectLimited(await client.get('/api/images').set('X-Forwarded-For', CLIENT_A), WINDOW_SECONDS.global);
  });
});

describe('media limiter (RATE_LIMIT_MEDIA, 1200 / 5 min / IP)', () => {
  it('F-40: /api/media/* has its own budget', async () => {
    const testApp = await appWith({ RATE_LIMIT_MEDIA: String(LIMIT) });
    const client = request(testApp.app);

    expect((await client.get(UNKNOWN_MEDIA).set('X-Forwarded-For', CLIENT_A)).status).toBe(404);
    expect((await client.head(UNKNOWN_MEDIA).set('X-Forwarded-For', CLIENT_A)).status).toBe(404);
    const limited = await client.get(UNKNOWN_MEDIA).set('X-Forwarded-For', CLIENT_A);

    expectLimited(limited, WINDOW_SECONDS.media);
    expect((await client.get(UNKNOWN_MEDIA).set('X-Forwarded-For', CLIENT_B)).status).toBe(404);
    // Media requests never count against the API's budget, and vice versa.
    expect((await client.get('/api/images').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
  });
});

describe('identity limiter (RATE_LIMIT_IDENTITIES, 20 / h / IP)', () => {
  it('F-40 / ADR 0002: only new identities count; an existing session is never refused', async () => {
    const testApp = await appWith({ RATE_LIMIT_IDENTITIES: String(LIMIT) });
    const existing = await sessionFrom(testApp, CLIENT_A);
    await sessionFrom(testApp, CLIENT_A);

    const limited = await request(testApp.app).get('/api/session').set('X-Forwarded-For', CLIENT_A);

    expectLimited(limited, WINDOW_SECONDS.identities);
    expect(setCookie(limited, 'imageboard.sid')).toBeUndefined();
    for (let i = 0; i < LIMIT + 1; i += 1) {
      expect((await existing.agent.get('/api/session').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
    }
    expect((await request(testApp.app).get('/api/session').set('X-Forwarded-For', CLIENT_B)).status).toBe(200);
  });
});

describe('upload limiters', () => {
  it('F-40: RATE_LIMIT_UPLOADS (10 / h) is per IP, and a refused upload stores nothing', async () => {
    const storage = createFakeStorage();
    const testApp = await appWith({ RATE_LIMIT_UPLOADS: String(LIMIT) }, storage);
    const a = await sessionFrom(testApp, CLIENT_A);
    const b = await sessionFrom(testApp, CLIENT_B);

    expect((await postImage(a, CLIENT_A)).status).toBe(201);
    expect((await postImage(a, CLIENT_A)).status).toBe(201);
    const puts = storage.calls().put;
    const limited = await postImage(a, CLIENT_A);

    expectLimited(limited, WINDOW_SECONDS.uploads);
    expect(storage.calls().put).toBe(puts);
    expect((await postImage(b, CLIENT_B)).status).toBe(201);
  });

  it('F-40 / ADR 0019: RATE_LIMIT_UPLOADS_GLOBAL_DAY (200 / day) is one budget for all clients together', async () => {
    const storage = createFakeStorage();
    const testApp = await appWith({ RATE_LIMIT_UPLOADS_GLOBAL_DAY: String(LIMIT) }, storage);

    expect((await postImage(await sessionFrom(testApp, CLIENT_A), CLIENT_A)).status).toBe(201);
    expect((await postImage(await sessionFrom(testApp, CLIENT_B), CLIENT_B)).status).toBe(201);
    const puts = storage.calls().put;
    const limited = await postImage(await sessionFrom(testApp, CLIENT_C), CLIENT_C);

    expectLimited(limited, WINDOW_SECONDS.uploadsGlobalDay);
    expect(storage.calls().put).toBe(puts);
  });
});

describe('comments limiter (RATE_LIMIT_COMMENTS, 20 / 10 min / IP)', () => {
  it('F-40: posting comments has its own budget; reading them does not count', async () => {
    const testApp = await appWith({ RATE_LIMIT_COMMENTS: String(LIMIT) });
    const session = await sessionFrom(testApp, CLIENT_A);
    const { id } = ImageDto.parse((await postImage(session, CLIENT_A)).body);

    expect((await postComment(session, CLIENT_A, id)).status).toBe(201);
    expect((await postComment(session, CLIENT_A, id)).status).toBe(201);
    const limited = await postComment(session, CLIENT_A, id);

    expectLimited(limited, WINDOW_SECONDS.comments);
    const thread = await session.agent.get(`/api/images/${String(id)}/comments`).set('X-Forwarded-For', CLIENT_A);
    expect(thread.status).toBe(200);
    expect(CommentPage.parse(thread.body).items).toHaveLength(LIMIT);
    const other = await sessionFrom(testApp, CLIENT_B);
    expect((await postComment(other, CLIENT_B, id)).status).toBe(201);
  });
});

describe('deletes limiter (RATE_LIMIT_DELETES, 30 / 10 min / IP)', () => {
  it('F-40: one budget shared by DELETE /api/images/:id and DELETE /api/comments/:id', async () => {
    const testApp = await appWith({ RATE_LIMIT_DELETES: String(LIMIT) });
    const session = await sessionFrom(testApp, CLIENT_A);
    const first = ImageDto.parse((await postImage(session, CLIENT_A)).body);
    const second = ImageDto.parse((await postImage(session, CLIENT_A)).body);
    const comment = CommentDto.parse((await postComment(session, CLIENT_A, first.id)).body);
    const remove = (path: string) =>
      session.agent.delete(path).set('X-Forwarded-For', CLIENT_A).set('x-csrf-token', session.csrfToken);

    expect((await remove(`/api/comments/${String(comment.id)}`)).status).toBe(204);
    expect((await remove(`/api/images/${String(first.id)}`)).status).toBe(204);
    const limited = await remove(`/api/images/${String(second.id)}`);

    expectLimited(limited, WINDOW_SECONDS.deletes);
    const stillThere = await session.agent.get(`/api/images/${String(second.id)}`).set('X-Forwarded-For', CLIENT_A);
    expect(stillThere.status).toBe(200);
  });
});
