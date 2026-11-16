import type { RequestHandler } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeStorage, type FakeStorage, silentLogger } from '../../../../test/fakes.js';
import { jpegWithGps, png } from '../../../../test/fixtures.js';
import { problemOf } from '../../../../test/http.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import type { ImageUploadPort } from '../../../shared/ports/image-upload.js';
import type { ObjectStorage } from '../../../shared/storage/object-storage.js';
import { createUploadModule } from '../index.js';

const UUID = '0b9d3c2a-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const passThrough: RequestHandler = (_req, _res, next) => {
  next();
};

/** The real upload port on the same storage as the app, to store objects exactly as an upload does. */
function uploadPortOn(storage: ObjectStorage): ImageUploadPort {
  return createUploadModule({
    storage,
    logger: silentLogger(),
    config: { maxPixels: 40_000_000, maxFrames: 200, maxEdge: 2560, mediaPublicBaseUrl: '/api/media' },
    mediaLimiter: passThrough,
    sleep: () => Promise.resolve(),
  }).port;
}

function expectMediaHeaders(response: request.Response, contentType: string, length: number): void {
  expect(response.headers['content-type']).toBe(contentType);
  expect(response.headers['content-length']).toBe(String(length));
  expect(response.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
  expect(Number.isNaN(Date.parse(String(response.headers['last-modified'])))).toBe(false);
  expect(response.headers['cache-control']).toBe('public, max-age=86400, immutable');
  expect(response.headers['content-disposition']).toBe('inline');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  // Mounted before the session middleware: no cookie, no Redis session per image (ADR 0004).
  expect(response.headers['set-cookie']).toBeUndefined();
}

describe('GET/HEAD /api/media/{images,previews}/:file', () => {
  let testApp: TestApp;
  let storage: FakeStorage;
  let upload: ImageUploadPort;
  let objectKey: string;
  let stored: { original: Buffer; preview: Buffer };

  async function bytesOf(key: string): Promise<Buffer> {
    const object = await storage.get(key);
    if (object.status !== 'ok') throw new Error(`expected ${key} to be stored`);
    return Buffer.concat(await object.body.toArray());
  }

  beforeAll(async () => {
    storage = createFakeStorage();
    testApp = await createTestApp({ storage });
    upload = uploadPortOn(storage);
    ({ objectKey } = await upload.ingest({ buffer: jpegWithGps(), size: jpegWithGps().length }));
    stored = {
      original: await bytesOf(objectKey),
      preview: await bytesOf(upload.previewUrl(objectKey).replace('/api/media/', '')),
    };
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-22, B-05: serves the original with the stored type and the data-only headers', async () => {
    const response = await request(testApp.app).get(upload.publicUrl(objectKey));

    expect(response.status).toBe(200);
    expectMediaHeaders(response, 'image/jpeg', stored.original.length);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, stored.original)).toBe(0);
  });

  it('B-06: the served original carries no EXIF/GPS', async () => {
    const response = await request(testApp.app).get(upload.publicUrl(objectKey));

    expect((await sharp(response.body as Buffer).metadata()).exif).toBeUndefined();
  });

  it('ADR 0018: serves the preview as image/webp with the same headers', async () => {
    const response = await request(testApp.app).get(upload.previewUrl(objectKey));

    expect(response.status).toBe(200);
    expectMediaHeaders(response, 'image/webp', stored.preview.length);
    expect(Buffer.compare(response.body as Buffer, stored.preview)).toBe(0);
  });

  it('HEAD answers the same headers without a body', async () => {
    const response = await request(testApp.app).head(upload.publicUrl(objectKey));

    expect(response.status).toBe(200);
    expectMediaHeaders(response, 'image/jpeg', stored.original.length);
    expect(response.text).toBeUndefined();
  });

  it('If-None-Match with the current ETag is 304 with ETag and Cache-Control, no body', async () => {
    const first = await request(testApp.app).get(upload.publicUrl(objectKey));
    const etag = String(first.headers['etag']);

    const response = await request(testApp.app).get(upload.publicUrl(objectKey)).set('If-None-Match', etag);

    expect(response.status).toBe(304);
    expect(response.headers['etag']).toBe(etag);
    expect(response.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(response.text).toBe('');
  });

  it('If-None-Match with another ETag is a full 200', async () => {
    const response = await request(testApp.app).get(upload.publicUrl(objectKey)).set('If-None-Match', '"other"');

    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body as Buffer, stored.original)).toBe(0);
  });

  it.each([
    ['encoded traversal', '/api/media/images/..%2F..%2Fetc%2Fpasswd'],
    ['traversal to a preview', `/api/media/images/..%2Fpreviews%2F${UUID}.webp`],
    ['uppercase UUID', `/api/media/images/${UUID.toUpperCase()}.jpg`],
    ['uppercase extension', `/api/media/images/${UUID}.JPG`],
    ['svg extension', `/api/media/images/${UUID}.svg`],
    ['html extension', `/api/media/images/${UUID}.html`],
    ['double extension', `/api/media/images/${UUID}.jpg.html`],
    ['UUID v1', '/api/media/images/0b9d3c2a-5e6f-1a1b-8c2d-3e4f5a6b7c8d.jpg'],
    ['preview with a jpg extension', `/api/media/previews/${UUID}.jpg`],
    ['nested path', `/api/media/images/x/${UUID}.jpg`],
    ['no prefix', `/api/media/${UUID}.jpg`],
  ])('404 for a bad key (%s) without calling storage', async (_label, path) => {
    const before = storage.calls().get;

    const response = await request(testApp.app).get(path);

    expect(response.status).toBe(404);
    expect(problemOf(response).code).toBe('not-found');
    expect(storage.calls().get).toBe(before);
  });

  it('F-36: 404 not-found for a well-formed key that is not stored', async () => {
    const response = await request(testApp.app).get(`/api/media/images/${UUID}.png`);

    expect(response.status).toBe(404);
    expect(problemOf(response)).toMatchObject({ code: 'not-found', detail: 'Image was not found.' });
  });

  it('F-36, B-07: after discard, both the original and the preview are 404', async () => {
    const own = await upload.ingest({ buffer: png(), size: png().length });
    expect((await request(testApp.app).get(upload.publicUrl(own.objectKey))).status).toBe(200);

    await upload.discard(own.objectKey);

    const original = await request(testApp.app).get(upload.publicUrl(own.objectKey));
    const preview = await request(testApp.app).get(upload.previewUrl(own.objectKey));
    expect(original.status).toBe(404);
    expect(preview.status).toBe(404);
    expect(problemOf(preview).code).toBe('not-found');
  });
});

describe('media route failures and limits', () => {
  const apps: TestApp[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('any other storage failure is a generic 500 problem without driver details', async () => {
    const broken: ObjectStorage = {
      ...createFakeStorage(),
      get: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:9000')),
    };
    const testApp = await createTestApp({ storage: broken });
    apps.push(testApp);

    const response = await request(testApp.app).get(`/api/media/images/${UUID}.jpg`);

    expect(response.status).toBe(500);
    const problem = problemOf(response);
    expect(problem.code).toBe('internal-error');
    expect(JSON.stringify(problem)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7/);
    // The error response is not an image: no immutable caching, no stored type.
    expect(response.headers['cache-control'] ?? '').not.toMatch(/immutable/);
  });

  it('ADR 0013: the media limiter answers 429 once RATE_LIMIT_MEDIA is used up', async () => {
    const testApp = await createTestApp({ env: { RATE_LIMIT_MEDIA: '2' } });
    apps.push(testApp);
    const path = `/api/media/images/${UUID}.jpg`;

    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await request(testApp.app).get(path)).status);

    expect(statuses).toEqual([404, 404, 429]);
    const limited = await request(testApp.app).get(path);
    expect(problemOf(limited).code).toBe('rate-limited');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
