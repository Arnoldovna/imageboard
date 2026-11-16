import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { problemApp, problemOf } from '../../../../test/http.js';
import { rateLimiter, securityHeaders } from '../security.js';

function limitedApp(scope: 'ip' | 'global') {
  return problemApp((app) => {
    app.set('trust proxy', 1);
    app.use(rateLimiter({ windowMs: 60_000, limit: 2, scope }));
    app.get('/api/thing', (_req, res) => {
      res.status(204).end();
    });
  });
}

const from = (app: express.Express, ip: string) => request(app).get('/api/thing').set('X-Forwarded-For', ip);

describe('rateLimiter', () => {
  it('B-09: answers 429 rate-limited problem+json with Retry-After and draft-8 headers', async () => {
    const app = limitedApp('ip');
    await from(app, '203.0.113.1');
    const second = await from(app, '203.0.113.1');
    const third = await from(app, '203.0.113.1');

    expect(second.status).toBe(204);
    expect(second.headers['ratelimit-policy']).toBeDefined();
    expect(second.headers['ratelimit']).toBeDefined();
    expect(third.status).toBe(429);
    expect(third.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(third.headers['retry-after']).toBeDefined();
    expect(problemOf(third).code).toBe('rate-limited');
  });

  it('counts each client address separately by default', async () => {
    const app = limitedApp('ip');
    await from(app, '203.0.113.1');
    await from(app, '203.0.113.1');

    expect((await from(app, '198.51.100.1')).status).toBe(204);
  });

  it('groups IPv6 clients by their /56', async () => {
    const app = limitedApp('ip');
    await from(app, '2001:db8:0:100::1');
    await from(app, '2001:db8:0:1ff::2');

    expect((await from(app, '2001:db8:0:1aa::3')).status).toBe(429);
  });

  it('ADR 0013: the global scope shares one budget between all clients (daily upload cap)', async () => {
    const app = limitedApp('global');
    await from(app, '203.0.113.1');
    await from(app, '198.51.100.1');

    expect((await from(app, '192.0.2.1')).status).toBe(429);
  });
});

describe('securityHeaders', () => {
  function headersFor(hsts: boolean) {
    const app = express();
    app.use(securityHeaders({ hsts }));
    app.get('/api/thing', (_req, res) => res.json({}));
    return request(app).get('/api/thing');
  }

  it('F-42 / B-10: forbids every resource type for API responses and sets the baseline headers', async () => {
    const response = await headersFor(false);

    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('F-42: sends HSTS only when enabled (production)', async () => {
    expect((await headersFor(true)).headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});
