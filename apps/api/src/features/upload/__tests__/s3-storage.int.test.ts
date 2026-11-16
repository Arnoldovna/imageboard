import { randomBytes, randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../../../test/fakes.js';
import { png } from '../../../../test/fixtures.js';
import { MINIO_IMAGE } from '../../../../test/images.js';
import {
  createS3Storage,
  type GetObjectResult,
  ObjectNotFoundError,
  type ObjectStorage,
} from '../../../shared/storage/object-storage.js';
import { createUploadModule } from '../index.js';

/*
 * The S3 adapter (shared/storage/object-storage.ts) against a real MinIO (Chainguard image, digest from
 * test/images.ts): put/get/304/NoSuchKey/delete as the media route relies on them (ADR 0004, 0017), AWS SDK v3 with
 * SigV4 and no ACLs (F-48, B-08, B-36). Credentials are throwaway values for this container only.
 */
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = randomBytes(24).toString('base64url');
const REGION = 'eu-central-1';
const BUCKET = 'imageboard-test';
const MINIO_PORT = 9000;

type Ok = Extract<GetObjectResult, { status: 'ok' }>;

function expectOk(result: GetObjectResult): Ok {
  if (result.status !== 'ok') throw new Error(`expected an object, got ${result.status}`);
  return result;
}

describe('S3 adapter against MinIO', () => {
  let minio: StartedTestContainer;
  let endpoint: string;
  let storage: ObjectStorage & { destroy(): void };

  const storageFor = (bucket: string) =>
    createS3Storage({
      S3_ENDPOINT: endpoint,
      S3_REGION: REGION,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: SECRET_KEY,
      S3_FORCE_PATH_STYLE: true,
    });

  beforeAll(async () => {
    minio = await new GenericContainer(MINIO_IMAGE)
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
      .withExposedPorts(MINIO_PORT)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', MINIO_PORT))
      .start();
    endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(MINIO_PORT))}`;

    // A private bucket: no policy, no ACL (B-08), like the compose `minio-init` one-shot creates it.
    const admin = new S3Client({
      region: REGION,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();

    storage = storageFor(BUCKET);
  });

  afterAll(async () => {
    storage.destroy();
    await minio.stop();
  });

  const newKey = (extension = 'png') => `images/${randomUUID()}.${extension}`;

  it('F-47: isReady is true for the bucket and false for a missing one', async () => {
    const missing = storageFor('no-such-bucket');

    expect(await storage.isReady()).toBe(true);
    expect(await missing.isReady()).toBe(false);
    missing.destroy();
  });

  it('put then get returns the bytes with type, length, quoted ETag and Last-Modified', async () => {
    const key = newKey();
    const body = png();
    await storage.put(key, body, 'image/png');

    const object = expectOk(await storage.get(key));
    const bytes = Buffer.concat(await object.body.toArray());

    expect(object.contentType).toBe('image/png');
    expect(object.contentLength).toBe(body.length);
    expect(object.etag).toMatch(/^"[^"]+"$/);
    expect(object.lastModified).toBeInstanceOf(Date);
    expect(Buffer.compare(bytes, body)).toBe(0);
  });

  it('maps a matching If-None-Match to not-modified with the current ETag', async () => {
    const key = newKey();
    await storage.put(key, png(), 'image/png');
    const first = expectOk(await storage.get(key));
    first.body.destroy();

    const result = await storage.get(key, { ifNoneMatch: first.etag });

    expect(result).toEqual({ status: 'not-modified', etag: first.etag });
  });

  it('serves the object when If-None-Match names another ETag', async () => {
    const key = newKey();
    await storage.put(key, png(), 'image/png');

    const result = expectOk(await storage.get(key, { ifNoneMatch: '"0123456789abcdef0123456789abcdef"' }));
    result.body.destroy();

    expect(result.status).toBe('ok');
  });

  it('maps NoSuchKey to ObjectNotFoundError with the key', async () => {
    const key = newKey();

    const rejection = storage.get(key);

    await expect(rejection).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(rejection).rejects.toMatchObject({ key });
  });

  it('delete removes the object, and deleting a missing key resolves (idempotent)', async () => {
    const key = newKey();
    await storage.put(key, png(), 'image/png');

    await storage.delete(key);

    await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('B-08: objects are private; an anonymous GET on the bucket URL is refused', async () => {
    const key = newKey();
    await storage.put(key, png(), 'image/png');

    const response = await fetch(`${endpoint}/${BUCKET}/${key}`);
    await response.body?.cancel();

    expect(response.status).toBe(403);
  });

  it('F-23, F-48: the real upload port stores original + preview on S3 and discard removes both', async () => {
    const { port } = createUploadModule({
      storage,
      logger: silentLogger(),
      config: { maxPixels: 40_000_000, maxFrames: 200, maxEdge: 2560, mediaPublicBaseUrl: '/api/media' },
      mediaLimiter: (_req, _res, next) => {
        next();
      },
      sleep: () => Promise.resolve(),
    });

    const stored = await port.ingest({ buffer: png(), size: png().length });
    const previewKey = port.previewUrl(stored.objectKey).replace('/api/media/', '');
    const original = expectOk(await storage.get(stored.objectKey));
    const preview = expectOk(await storage.get(previewKey));
    original.body.destroy();
    preview.body.destroy();

    expect(original.contentType).toBe('image/png');
    expect(original.contentLength).toBe(stored.sizeBytes);
    expect(preview.contentType).toBe('image/webp');

    await port.discard(stored.objectKey);

    await expect(storage.get(stored.objectKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.get(previewKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});
