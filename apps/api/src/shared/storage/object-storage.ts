import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

import { READINESS_MS } from '../../config/app.js';
import type { Env } from '../../config/env.js';

/** Port used by services. Tests pass an in-memory fake; production passes the S3 adapter. */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Readable; contentType: string | undefined }>;
  delete(key: string): Promise<void>;
  isReady(): Promise<boolean>;
}

type S3Env = Pick<
  Env,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

/** The S3 adapter: the port plus `destroy()` for the composition root (closes the client's sockets on shutdown). */
export function createS3Storage(env: S3Env): ObjectStorage & { destroy(): void } {
  const client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE, // MinIO needs path-style URLs
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    // Only send/require checksums when the operation demands it; keeps S3-compatible servers working.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // The SDK default is no connect timeout: an unreachable endpoint would hold a request until the OS gives up.
    requestHandler: { connectionTimeout: 3_000 },
  });
  const Bucket = env.S3_BUCKET;

  return {
    destroy() {
      client.destroy();
    },
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return { body: out.Body as Readable, contentType: out.ContentType };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async isReady() {
      try {
        // Bounded like every readiness check (incl. SDK retries), so a hanging endpoint cannot pile up requests.
        await client.send(new HeadBucketCommand({ Bucket }), {
          abortSignal: AbortSignal.timeout(READINESS_MS.checkTimeoutMs),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
