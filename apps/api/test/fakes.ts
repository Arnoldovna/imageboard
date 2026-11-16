import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { pino, type Logger } from 'pino';

import { type GetObjectResult, ObjectNotFoundError, type ObjectStorage } from '../src/shared/storage/object-storage.js';

/** A logger that drops everything (integration and unit tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export interface FakeStorageOptions {
  /** Every put rejects (storage outage). */
  failPut?: boolean;
  /** The first n delete calls reject (transient failures for the retry logic). */
  failDelete?: number;
}

interface StoredObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: Date;
}

export interface FakeStorage extends ObjectStorage {
  /** Keys currently stored, sorted. */
  keys(): string[];
  /** Number of put, delete and get calls so far, including failed ones. */
  calls(): { put: number; delete: number; get: number };
}

/**
 * In-memory `ObjectStorage` with the same contract as the S3 adapter (ADR 0017): ETag = quoted sha256 hex of the
 * bytes, `lastModified` = put time, `If-None-Match` → `not-modified`, missing key → `ObjectNotFoundError`, delete of
 * a missing key resolves.
 */
export function createFakeStorage(options: FakeStorageOptions = {}): FakeStorage {
  const objects = new Map<string, StoredObject>();
  const counts = { put: 0, delete: 0, get: 0 };
  let deleteFailuresLeft = options.failDelete ?? 0;

  return {
    put(key, body, contentType) {
      counts.put += 1;
      if (options.failPut) return Promise.reject(new Error(`fake storage: put ${key} failed`));
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      objects.set(key, { body: Uint8Array.from(body), contentType, etag, lastModified: new Date() });
      return Promise.resolve();
    },
    get(key, getOptions = {}): Promise<GetObjectResult> {
      counts.get += 1;
      const object = objects.get(key);
      if (!object) return Promise.reject(new ObjectNotFoundError(key));
      if (getOptions.ifNoneMatch === object.etag) {
        return Promise.resolve({ status: 'not-modified', etag: object.etag });
      }
      return Promise.resolve({
        status: 'ok',
        body: Readable.from([Buffer.from(object.body)]),
        contentType: object.contentType,
        contentLength: object.body.byteLength,
        etag: object.etag,
        lastModified: object.lastModified,
      });
    },
    delete(key) {
      counts.delete += 1;
      if (deleteFailuresLeft > 0) {
        deleteFailuresLeft -= 1;
        return Promise.reject(new Error(`fake storage: delete ${key} failed`));
      }
      objects.delete(key);
      return Promise.resolve();
    },
    isReady: () => Promise.resolve(true),
    keys: () => [...objects.keys()].sort(),
    calls: () => ({ ...counts }),
  };
}
