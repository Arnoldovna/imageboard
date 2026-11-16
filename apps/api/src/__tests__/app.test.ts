import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { memoryRateLimitStores } from '../shared/security/security.js';

function appWithGlobalLimit(limit: number) {
  const env = loadEnv({
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/d',
    REDIS_URL: 'redis://127.0.0.1:6379',
    SESSION_SECRET: 'unit-session-secret-at-least-32-chars',
    CSRF_SECRET: 'unit-csrf-secret-at-least-32-characters',
    S3_BUCKET: 'unit-bucket',
    S3_ACCESS_KEY_ID: 'unit',
    S3_SECRET_ACCESS_KEY: 'unit',
    RATE_LIMIT_GLOBAL: String(limit),
  });
  return createApp({
    env,
    logger: pino({ level: 'silent' }),
    rateLimitStores: memoryRateLimitStores,
    readiness: {},
    isShuttingDown: () => false,
  });
}

describe('createApp middleware order', () => {
  it('F-40: malformed JSON bodies count against the global limiter (it runs before body parsing)', async () => {
    const app = appWithGlobalLimit(2);
    const malformed = () =>
      request(app).post('/api/anything').set('Content-Type', 'application/json').send('{"broken": ');

    expect((await malformed()).status).toBe(400);
    expect((await malformed()).status).toBe(400);
    const limited = await malformed();

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('F-49: a JSON body over 16 KB is rejected with 413 problem+json', async () => {
    const response = await request(appWithGlobalLimit(100))
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(16 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  });

  it('F-47: health is not counted by the global limiter', async () => {
    const app = appWithGlobalLimit(1);

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/health/live')).status).toBe(200);
    }
    expect((await request(app).get('/api/anything')).status).toBe(404);
  });
});
