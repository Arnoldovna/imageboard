import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { problemApp, problemOf } from '../../../../test/http.js';
import { createFetchMetadataGuard, type FetchMetadataOptions } from '../fetch-metadata.js';

function app(options: FetchMetadataOptions = {}, trustProxy = 0) {
  return problemApp((server) => {
    server.set('trust proxy', trustProxy);
    server.use(createFetchMetadataGuard(options));
    server.all('/api/thing', (_req, res) => {
      res.status(204).end();
    });
  });
}

function expectCrossOrigin(response: request.Response): void {
  expect(response.status).toBe(403);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemOf(response).code).toBe('cross-origin-request');
}

describe('fetch-metadata guard (ADR 0003)', () => {
  it.each(['same-origin', 'none', 'Same-Origin'])('B-03: lets a POST with Sec-Fetch-Site %s through', async (site) => {
    expect((await request(app()).post('/api/thing').set('Sec-Fetch-Site', site)).status).toBe(204);
  });

  it.each(['cross-site', 'same-site'])('B-03: rejects a POST with Sec-Fetch-Site %s', async (site) => {
    expectCrossOrigin(await request(app()).post('/api/thing').set('Sec-Fetch-Site', site));
  });

  it('B-03: rejects a DELETE from a foreign site even with a matching Origin header', async () => {
    const response = await request(app())
      .delete('/api/thing')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'http://127.0.0.1');

    expectCrossOrigin(response);
  });

  it('never blocks safe methods', async () => {
    const response = await request(app()).get('/api/thing').set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(204);
  });

  describe('without Sec-Fetch-Site (older browsers)', () => {
    it('accepts an Origin equal to the request’s own origin when APP_ORIGIN is unset', async () => {
      const response = await request(app())
        .post('/api/thing')
        .set('Host', 'gallery.test')
        .set('Origin', 'http://gallery.test');

      expect(response.status).toBe(204);
    });

    it('B-03: rejects a foreign Origin', async () => {
      const response = await request(app())
        .post('/api/thing')
        .set('Host', 'gallery.test')
        .set('Origin', 'https://evil.test');

      expectCrossOrigin(response);
    });

    it('B-03: rejects the opaque Origin "null" (sandboxed iframes, data: URLs)', async () => {
      expectCrossOrigin(await request(app()).post('/api/thing').set('Origin', 'null'));
    });

    it('compares against APP_ORIGIN when it is set', async () => {
      const guarded = app({ appOrigin: 'https://imageboard.example' });

      expect((await request(guarded).post('/api/thing').set('Origin', 'https://imageboard.example')).status).toBe(204);
      expectCrossOrigin(
        await request(guarded).post('/api/thing').set('Host', 'internal:3000').set('Origin', 'http://internal:3000'),
      );
    });

    it('uses the forwarded scheme behind a trusted proxy', async () => {
      const response = await request(app({}, 1))
        .post('/api/thing')
        .set('Host', 'imageboard.example')
        .set('X-Forwarded-Proto', 'https')
        .set('Origin', 'https://imageboard.example');

      expect(response.status).toBe(204);
    });

    it('lets requests without Origin through to the CSRF check (curl, Supertest)', async () => {
      expect((await request(app()).post('/api/thing')).status).toBe(204);
    });
  });
});
