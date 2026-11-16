import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createLogger, createRequestLogger, truncateIp } from '../logger.js';

interface LogLine {
  level: number;
  msg?: string;
  req?: { id?: string; url?: string; remoteAddress?: string; headers?: Record<string, unknown> };
  res?: { statusCode?: number; headers?: Record<string, unknown> };
  [key: string]: unknown;
}

/** An app with the real logger writing into memory. */
function loggedApp(options: { trustProxy?: number } = {}) {
  const lines: LogLine[] = [];
  const logger = createLogger(
    { LOG_LEVEL: 'info', NODE_ENV: 'test' },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine);
      },
    },
  );
  const app = express();
  app.set('trust proxy', options.trustProxy ?? 0);
  app.use(createRequestLogger(logger));
  app.get('/api/thing', (_req, res) => {
    res.cookie('imageboard.sid', 'session-secret-value').json({ ok: true });
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/media/images/x.jpg', (_req, res) => res.status(200).end());
  app.get('/api/media/images/missing.jpg', (_req, res) => res.status(404).end());
  app.post('/api/login-like', express.json(), (req, res) => {
    req.log.info({ body: req.body as unknown }, 'should never happen in app code; proves redaction');
    res.status(204).end();
  });
  return { app, lines };
}

describe('request logging (F-46)', () => {
  it('B-29: never logs cookies, CSRF tokens, authorization or x-forwarded-for, and redacts set-cookie', async () => {
    const { app, lines } = loggedApp();

    await request(app)
      .get('/api/thing')
      .set('Cookie', 'imageboard.sid=s%3Asecret-session')
      .set('x-csrf-token', 'csrf-token-value')
      .set('Authorization', 'Bearer token-value')
      .set('X-Forwarded-For', '203.0.113.9');

    const output = JSON.stringify(lines);
    expect(output).not.toContain('secret-session');
    expect(output).not.toContain('csrf-token-value');
    expect(output).not.toContain('token-value');
    expect(output).not.toContain('203.0.113.9');
    expect(output).not.toContain('session-secret-value');
    const line = lines.find((entry) => entry.req?.url === '/api/thing');
    for (const header of ['cookie', 'x-csrf-token', 'authorization', 'x-forwarded-for']) {
      expect(line?.req?.headers, header).not.toHaveProperty(header);
    }
    expect(line?.res?.headers?.['set-cookie']).toBe('[redacted]');
  });

  it.each([
    ['Forwarded', 'for=198.51.100.77;proto=https'],
    ['X-Real-IP', '198.51.100.77'],
    ['True-Client-IP', '198.51.100.77'],
    ['CF-Connecting-IP', '198.51.100.77'],
    ['Fastly-Client-IP', '198.51.100.77'],
    ['X-Client-IP', '198.51.100.77'],
    // Headers no list of known names would contain: the allow-list keeps them out all the same.
    ['X-Original-Forwarded-For', '198.51.100.77'],
    ['X-Envoy-External-Address', '198.51.100.77'],
    ['X-Azure-ClientIP', '198.51.100.77'],
  ])('ADR 0019: never logs the full client address that a proxy or CDN sends in %s', async (header, value) => {
    const { app, lines } = loggedApp();

    await request(app).get('/api/thing').set(header, value);

    expect(JSON.stringify(lines)).not.toContain('198.51.100.77');
    const line = lines.find((entry) => entry.req?.url === '/api/thing');
    expect(line?.req?.headers).not.toHaveProperty(header.toLowerCase());
  });

  it('F-46: logs only the allow-listed request headers', async () => {
    const { app, lines } = loggedApp();

    await request(app)
      .get('/api/thing')
      .set('User-Agent', 'logger-test/1.0')
      .set('Accept', 'application/json')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-Something-New', 'not logged');

    const line = lines.find((entry) => entry.req?.url === '/api/thing');
    expect(line?.req?.headers).toEqual({
      host: expect.any(String) as unknown,
      'user-agent': 'logger-test/1.0',
      accept: 'application/json',
      'sec-fetch-site': 'same-origin',
    });
  });

  it('redacts password and secret fields anywhere one level deep', async () => {
    const { app, lines } = loggedApp();

    await request(app).post('/api/login-like').send({ password: 'hunter2-password', secret: 'top-secret-value' });

    const output = JSON.stringify(lines);
    expect(output).not.toContain('hunter2-password');
    expect(output).not.toContain('top-secret-value');
  });

  it('accepts a well-formed x-request-id and echoes it', async () => {
    const { app, lines } = loggedApp();

    const response = await request(app).get('/api/thing').set('x-request-id', 'nginx-0123456789abcdef');

    expect(response.headers['x-request-id']).toBe('nginx-0123456789abcdef');
    expect(lines.at(-1)?.req?.id).toBe('nginx-0123456789abcdef');
  });

  it.each([['short'], ['has spaces in it'], ['<script>alert(1)</script>'], ['x'.repeat(65)]])(
    'replaces a malformed x-request-id %j with a UUID',
    async (incoming) => {
      const { app } = loggedApp();

      const response = await request(app).get('/api/thing').set('x-request-id', incoming);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('ADR 0019: logs the client address truncated, behind the configured proxy hops', async () => {
    const { app, lines } = loggedApp({ trustProxy: 1 });

    await request(app).get('/api/thing').set('X-Forwarded-For', '198.51.100.77');

    expect(lines.at(-1)?.req?.remoteAddress).toBe('198.51.100.0');
    expect(lines.at(-1)?.req).not.toHaveProperty('remotePort');
  });

  it('does not log successful health and media requests, but logs their failures', async () => {
    const { app, lines } = loggedApp();

    await request(app).get('/api/health');
    await request(app).get('/api/media/images/x.jpg');
    expect(lines).toHaveLength(0);

    await request(app).get('/api/media/images/missing.jpg');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.res?.statusCode).toBe(404);
  });
});

describe('truncateIp', () => {
  it.each([
    ['203.0.113.195', '203.0.113.0'],
    ['::ffff:203.0.113.195', '203.0.113.0'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::'],
    ['2001:0db8:00ab:0012:0000:0000:0000:0001', '2001:db8:ab::'],
    ['::1', '0:0:0::'],
    // An embedded IPv4 tail is two groups wide, so the zero fill before it is one group shorter.
    ['::1:2:3:4:5:1.2.3.4', '0:1:2::'],
    ['1::2:3:4:5:1.2.3.4', '1:0:2::'],
    ['64:ff9b::198.51.100.7', '64:ff9b:0::'],
  ])('%s → %s', (input, expected) => {
    expect(truncateIp(input)).toBe(expected);
  });

  it('returns undefined for missing or invalid input', () => {
    expect(truncateIp(undefined)).toBeUndefined();
    expect(truncateIp('')).toBeUndefined();
    expect(truncateIp('not-an-ip')).toBeUndefined();
  });
});
