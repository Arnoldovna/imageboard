import { animationTooLarge, animationTooLong, fileMessages } from '@app/shared';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { captureLogger, createFakeStorage, type FakeStorage } from '../../../../test/fakes.js';
import { animatedWebp, apng, gif, htmlAsPng, jpegWithGps, pdf, png, svg } from '../../../../test/fixtures.js';
import { InvalidImageError, UnsupportedImageTypeError } from '../../../shared/errors/app-error.js';
import type { ObjectStorage } from '../../../shared/storage/object-storage.js';
import { createImageProcessor } from '../image-processor.js';
import { MEDIA_KEY_PATTERN, PREVIEW_KEY_PATTERN } from '../object-key.js';
import { MAX_ANIMATION_PIXELS } from '../upload.config.js';
import { createUploadService, type UploadServiceDeps } from '../upload.service.js';

const UUID = '0b9d3c2a-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const ORIGINAL_KEY = `images/${UUID}.png`;
const PREVIEW_KEY = `previews/${UUID}.webp`;

interface Failures {
  /** put rejects for keys matching this pattern. */
  put?: RegExp;
  /** delete rejects for keys matching this pattern, `times` times per key (Infinity = always). */
  delete?: { key: RegExp; times: number };
}

/** The fake storage with failures for chosen keys only (createFakeStorage's switches apply to every key). */
function selectivelyFailing(base: FakeStorage, failures: Failures): ObjectStorage {
  const deleteFailures = new Map<string, number>();
  return {
    ...base,
    put(key, body, contentType) {
      if (failures.put?.test(key)) return Promise.reject(new Error(`put ${key} failed`));
      return base.put(key, body, contentType);
    },
    delete(key) {
      const rule = failures.delete;
      const failed = deleteFailures.get(key) ?? 0;
      if (rule?.key.test(key) && failed < rule.times) {
        deleteFailures.set(key, failed + 1);
        return Promise.reject(new Error(`delete ${key} failed`));
      }
      return base.delete(key);
    },
  };
}

function setup(overrides: Partial<UploadServiceDeps> & { maxFrames?: number } = {}) {
  const storage = createFakeStorage();
  const log = captureLogger();
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  const { maxFrames = 200, ...deps } = overrides;
  const service = createUploadService({
    storage,
    logger: log.logger,
    processor: createImageProcessor({
      maxPixels: 40_000_000,
      maxFrames,
      maxEdge: 2560,
      maxAnimationPixels: MAX_ANIMATION_PIXELS,
    }),
    mediaPublicBaseUrl: '/api/media',
    sleep,
    ...deps,
  });
  return { service, storage, log, sleep };
}

async function storedContentType(storage: ObjectStorage, key: string): Promise<string> {
  const object = await storage.get(key);
  if (object.status !== 'ok') throw new Error('expected the object');
  object.body.destroy();
  return object.contentType;
}

describe('ingest', () => {
  it('F-21, F-22: stores the re-encoded original under a server key with the detected type, then the preview', async () => {
    const { service, storage } = setup();

    const stored = await service.ingest({ buffer: jpegWithGps(), size: jpegWithGps().length });

    expect(stored.objectKey).toMatch(MEDIA_KEY_PATTERN);
    expect(stored.objectKey.endsWith('.jpg')).toBe(true);
    expect(stored.mimeType).toBe('image/jpeg');
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 16, height: 32 });
    const previewKey = stored.objectKey.replace(/^images\/(.+)\.jpg$/, 'previews/$1.webp');
    expect(previewKey).toMatch(PREVIEW_KEY_PATTERN);
    expect(storage.keys()).toEqual([stored.objectKey, previewKey]);
    expect(await storedContentType(storage, stored.objectKey)).toBe('image/jpeg');
    expect(await storedContentType(storage, previewKey)).toBe('image/webp');
  });

  it('F-22: sizeBytes is the size of the stored object, which carries no EXIF (B-06)', async () => {
    const { service, storage } = setup();

    const stored = await service.ingest({ buffer: jpegWithGps(), size: jpegWithGps().length });
    const object = await storage.get(stored.objectKey);
    if (object.status !== 'ok') throw new Error('expected the object');
    const bytes = Buffer.concat(await object.body.toArray());

    expect(stored.sizeBytes).toBe(object.contentLength);
    expect(bytes.length).toBe(stored.sizeBytes);
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
  });

  it('R-07: an APNG is stored as image/png with a .png key', async () => {
    const { service } = setup();

    const stored = await service.ingest({ buffer: apng(), size: apng().length });

    expect(stored.mimeType).toBe('image/png');
    expect(stored.objectKey.endsWith('.png')).toBe(true);
  });

  it.each([
    ['SVG', svg],
    ['HTML named .png', htmlAsPng],
    ['PDF', pdf],
  ])('B-04: %s is 415 and nothing is stored', async (_label, buffer) => {
    const { service, storage } = setup();

    await expect(service.ingest({ buffer, size: buffer.length })).rejects.toBeInstanceOf(UnsupportedImageTypeError);
    expect(storage.calls().put).toBe(0);
    expect(storage.keys()).toEqual([]);
  });

  it('F-23: an unreadable image is 400 invalid-image and nothing is stored', async () => {
    const { service, storage } = setup();
    const whole = png({ width: 64, height: 64 });
    const buffer = whole.subarray(0, whole.length - 40); // truncated inside the pixel data

    const rejection = service.ingest({ buffer, size: buffer.length });

    await expect(rejection).rejects.toBeInstanceOf(InvalidImageError);
    await expect(rejection).rejects.toMatchObject({ message: fileMessages.unreadable });
    expect(storage.calls().put).toBe(0);
  });

  it('enforces the frame cap from the config before storing', async () => {
    const { service, storage } = setup({ maxFrames: 10 });
    const buffer = gif(11);

    await expect(service.ingest({ buffer, size: buffer.length })).rejects.toMatchObject({
      code: 'invalid-image',
      message: animationTooLong(10),
    });
    expect(storage.calls().put).toBe(0);
  });

  it('ADR 0005: refuses an animation bomb with the production limits before storing anything', async () => {
    const { service, storage } = setup();
    const buffer = animatedWebp(200, { width: 6000, height: 6000 });

    await expect(service.ingest({ buffer, size: buffer.length })).rejects.toMatchObject({
      code: 'invalid-image',
      message: animationTooLarge(MAX_ANIMATION_PIXELS),
    });
    expect(storage.calls().put).toBe(0);
  });

  it('ADR 0014: the seed can fix the key; the preview key is derived from it', async () => {
    const { service, storage } = setup();

    const stored = await service.ingest({ buffer: png(), size: png().length }, { objectKey: ORIGINAL_KEY });

    expect(stored.objectKey).toBe(ORIGINAL_KEY);
    expect(storage.keys()).toEqual([ORIGINAL_KEY, PREVIEW_KEY]);
  });

  it.each([
    ['an extension that differs from the detected type', `images/${UUID}.jpg`],
    ['a key outside the pattern', 'images/seed-1.png'],
    ['a preview key', PREVIEW_KEY],
  ])('rejects a fixed key with %s before storing anything', async (_label, objectKey) => {
    const { service, storage } = setup();

    await expect(service.ingest({ buffer: png(), size: png().length }, { objectKey })).rejects.toThrow(
      /Fixed object key/,
    );
    expect(storage.calls().put).toBe(0);
  });

  it('B-19, F-23: a failing original put rejects (no crash) and leaves nothing behind', async () => {
    const storage = createFakeStorage({ failPut: true });
    const { service } = setup({ storage });

    await expect(service.ingest({ buffer: png(), size: png().length })).rejects.toThrow(/put .* failed/);
    expect(storage.keys()).toEqual([]);
    // Both keys are deleted defensively: a timed-out put may still have landed.
    expect(storage.calls().delete).toBe(2);
  });

  it('ADR 0018: a failing preview put discards the original before rethrowing', async () => {
    const base = createFakeStorage();
    const storage = selectivelyFailing(base, { put: /^previews\// });
    const { service } = setup({ storage });

    await expect(service.ingest({ buffer: png(), size: png().length }, { objectKey: ORIGINAL_KEY })).rejects.toThrow(
      `put ${PREVIEW_KEY} failed`,
    );
    expect(base.calls().put).toBe(1); // the original was stored ...
    expect(base.keys()).toEqual([]); // ... and removed again
  });
});

describe('discard', () => {
  it('B-07: deletes the original and its preview', async () => {
    const { service, storage, sleep, log } = setup();
    await service.ingest({ buffer: png(), size: png().length }, { objectKey: ORIGINAL_KEY });

    await service.discard(ORIGINAL_KEY);

    expect(storage.keys()).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.errors()).toEqual([]);
  });

  it('is idempotent: discarding keys that are already gone resolves quietly', async () => {
    const { service, log } = setup();

    await expect(service.discard(ORIGINAL_KEY)).resolves.toBeUndefined();
    expect(log.errors()).toEqual([]);
  });

  it('ADR 0008: retries a failing delete with backoff (100 ms, then 400 ms) and succeeds', async () => {
    const base = createFakeStorage();
    const storage = selectivelyFailing(base, { delete: { key: /^previews\//, times: 2 } });
    const { service, sleep, log } = setup({ storage });
    await service.ingest({ buffer: png(), size: png().length }, { objectKey: ORIGINAL_KEY });

    await service.discard(ORIGINAL_KEY);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 400]);
    expect(base.keys()).toEqual([]);
    expect(log.errors()).toEqual([]);
  });

  it('ADR 0008: after 3 failed attempts it logs the orphan at error and never throws', async () => {
    const base = createFakeStorage();
    let previewDeletes = 0;
    const failing = selectivelyFailing(base, { delete: { key: /^previews\//, times: Number.POSITIVE_INFINITY } });
    const counting: ObjectStorage = {
      ...failing,
      delete(key) {
        if (key.startsWith('previews/')) previewDeletes += 1;
        return failing.delete(key);
      },
    };
    const { service, log } = setup({ storage: counting });
    await service.ingest({ buffer: png(), size: png().length }, { objectKey: ORIGINAL_KEY });

    await expect(service.discard(ORIGINAL_KEY)).resolves.toBeUndefined();

    expect(previewDeletes).toBe(3);
    expect(base.keys()).toEqual([PREVIEW_KEY]); // the original is gone, the preview is the orphan
    expect(log.errors()).toHaveLength(1);
    expect(log.errors()[0]).toMatchObject({
      objectKey: ORIGINAL_KEY,
      objectKeys: [ORIGINAL_KEY, PREVIEW_KEY],
      failedKeys: [PREVIEW_KEY],
      attempts: 3,
    });
  });

  it('never throws when storage itself throws synchronously', async () => {
    const base = createFakeStorage();
    const storage: ObjectStorage = {
      ...base,
      delete() {
        throw new Error('client destroyed');
      },
    };
    const { service, log } = setup({ storage });

    await expect(service.discard(ORIGINAL_KEY)).resolves.toBeUndefined();
    expect(log.errors()).toHaveLength(1);
  });

  it('refuses to delete a key that is not an image object key, and logs it', async () => {
    const { service, storage, log } = setup();

    await service.discard('../../etc/passwd');

    expect(storage.calls().delete).toBe(0);
    expect(log.errors()[0]).toMatchObject({ objectKey: '../../etc/passwd' });
  });
});

describe('publicUrl and previewUrl', () => {
  it('B-35: build URLs from MEDIA_PUBLIC_BASE_URL and the key at serialisation time', () => {
    const { service } = setup();

    expect(service.publicUrl(ORIGINAL_KEY)).toBe(`/api/media/${ORIGINAL_KEY}`);
    expect(service.previewUrl(ORIGINAL_KEY)).toBe(`/api/media/${PREVIEW_KEY}`);
  });

  it('accept a CDN base with a trailing slash without doubling it', () => {
    const { service } = setup({ mediaPublicBaseUrl: 'https://cdn.example.test/media/' });

    expect(service.publicUrl(ORIGINAL_KEY)).toBe(`https://cdn.example.test/media/${ORIGINAL_KEY}`);
    expect(service.previewUrl(ORIGINAL_KEY)).toBe(`https://cdn.example.test/media/${PREVIEW_KEY}`);
  });
});
