import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { createFakeStorage } from '../../../../test/fakes.js';
import { createS3ObjectStorage, ObjectNotFoundError, type ObjectStorage, type S3Send } from '../object-storage.js';

const lastModified = new Date('2026-11-12T19:23:00.000Z');

function serviceError(status: number, name: string): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status }, message: name });
}

/** A 304 as the SDK throws it: the raw response (with the object's ETag header) hangs on the error. */
function notModified(etag: string): S3ServiceException {
  const error = serviceError(304, 'NotModified');
  error.$response = { statusCode: 304, headers: { etag } };
  return error;
}

describe('S3 adapter (createS3ObjectStorage)', () => {
  it('B-08: puts with the detected content type and no ACL', async () => {
    const send = vi.fn<S3Send>(() => Promise.resolve({}));
    await createS3ObjectStorage(send, 'bucket').put('images/k.jpg', Uint8Array.of(1, 2), 'image/jpeg');

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toEqual({
      Bucket: 'bucket',
      Key: 'images/k.jpg',
      Body: Uint8Array.of(1, 2),
      ContentType: 'image/jpeg',
    });
    expect(command?.input).not.toHaveProperty('ACL');
  });

  it('returns body, length, ETag and Last-Modified for an object', async () => {
    const send = vi.fn<S3Send>(() =>
      Promise.resolve({
        Body: Readable.from(['bytes']),
        ContentType: 'image/png',
        ContentLength: 5,
        ETag: '"abc"',
        LastModified: lastModified,
      }),
    );
    const result = await createS3ObjectStorage(send, 'bucket').get('images/k.png');

    expect(result).toMatchObject({
      status: 'ok',
      contentType: 'image/png',
      contentLength: 5,
      etag: '"abc"',
      lastModified,
    });
    if (result.status === 'ok') expect(await text(result.body)).toBe('bytes');
  });

  it('passes If-None-Match through and maps a 304 to not-modified with the ETag S3 sent', async () => {
    const send = vi.fn<S3Send>(() => Promise.reject(notModified('"abc"')));
    const result = await createS3ObjectStorage(send, 'bucket').get('images/k.png', { ifNoneMatch: '"abc"' });

    expect(result).toEqual({ status: 'not-modified', etag: '"abc"' });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command?.input).toMatchObject({ IfNoneMatch: '"abc"' });
  });

  it.each(['W/"old", "abc"', '*'])('reports the object ETag, never the request header %s, on a 304', async (header) => {
    const storage = createS3ObjectStorage(() => Promise.reject(notModified('"abc"')), 'bucket');

    expect(await storage.get('images/k.png', { ifNoneMatch: header })).toEqual({
      status: 'not-modified',
      etag: '"abc"',
    });
  });

  it('falls back to a single requested tag when a 304 carries no ETag header', async () => {
    const storage = createS3ObjectStorage(() => Promise.reject(serviceError(304, 'NotModified')), 'bucket');

    expect(await storage.get('images/k.png', { ifNoneMatch: '"abc"' })).toEqual({
      status: 'not-modified',
      etag: '"abc"',
    });
  });

  it('rejects a 304 that names no ETag for a list or * (no valid header to send)', async () => {
    const storage = createS3ObjectStorage(() => Promise.reject(serviceError(304, 'NotModified')), 'bucket');

    await expect(storage.get('images/k.png', { ifNoneMatch: '"a", "b"' })).rejects.toThrow(/304 without an ETag/);
    await expect(storage.get('images/k.png', { ifNoneMatch: '*' })).rejects.toThrow(/304 without an ETag/);
  });

  it.each([
    ['NoSuchKey', new NoSuchKey({ message: 'missing', $metadata: { httpStatusCode: 404 } })],
    ['a bare 404', serviceError(404, 'NotFound')],
  ])('maps %s to ObjectNotFoundError', async (_case, error) => {
    const storage = createS3ObjectStorage(() => Promise.reject(error), 'bucket');

    await expect(storage.get('images/k.png')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('rethrows other failures unchanged (they become 500s)', async () => {
    const failure = serviceError(503, 'SlowDown');
    const storage = createS3ObjectStorage(() => Promise.reject(failure), 'bucket');

    await expect(storage.get('images/k.png')).rejects.toBe(failure);
  });

  it('rejects an incomplete response instead of streaming without headers', async () => {
    const storage = createS3ObjectStorage(() => Promise.resolve({ Body: Readable.from(['x']) }), 'bucket');

    await expect(storage.get('images/k.png')).rejects.toThrow(/Incomplete/);
  });

  it('deletes by key and reports readiness through HeadBucket', async () => {
    const send = vi.fn<S3Send>(() => Promise.resolve({}));
    const storage = createS3ObjectStorage(send, 'bucket');

    await storage.delete('images/k.png');
    await expect(storage.isReady()).resolves.toBe(true);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('B-87: reports not ready when HeadBucket fails', async () => {
    await expect(createS3ObjectStorage(() => Promise.reject(new Error('down')), 'bucket').isReady()).resolves.toBe(
      false,
    );
  });
});

describe('fake storage (test/fakes.ts) keeps the port contract', () => {
  async function roundTrip(storage: ObjectStorage) {
    await storage.put('images/a.png', Uint8Array.of(1, 2, 3), 'image/png');
    const first = await storage.get('images/a.png');
    if (first.status !== 'ok') throw new Error('expected an object');
    return first;
  }

  it('stores bytes with a quoted sha256 ETag and answers If-None-Match with not-modified', async () => {
    const storage = createFakeStorage();
    const first = await roundTrip(storage);

    expect(first).toMatchObject({ contentType: 'image/png', contentLength: 3 });
    expect(first.etag).toMatch(/^"[0-9a-f]{64}"$/);
    await expect(storage.get('images/a.png', { ifNoneMatch: first.etag })).resolves.toEqual({
      status: 'not-modified',
      etag: first.etag,
    });
  });

  it('throws ObjectNotFoundError for missing keys and deletes idempotently', async () => {
    const storage = createFakeStorage();
    await roundTrip(storage);

    await storage.delete('images/a.png');
    await storage.delete('images/a.png');

    await expect(storage.get('images/a.png')).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(storage.keys()).toEqual([]);
  });

  it('can fail puts and the first n deletes', async () => {
    await expect(createFakeStorage({ failPut: true }).put('k', Uint8Array.of(1), 'image/png')).rejects.toThrow();

    const storage = createFakeStorage({ failDelete: 2 });
    await roundTrip(storage);
    await expect(storage.delete('images/a.png')).rejects.toThrow();
    await expect(storage.delete('images/a.png')).rejects.toThrow();
    await storage.delete('images/a.png');
    expect(storage.keys()).toEqual([]);
    expect(storage.calls().delete).toBe(3);
  });
});
