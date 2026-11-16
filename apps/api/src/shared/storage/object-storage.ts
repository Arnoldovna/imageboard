import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

import { READINESS_MS } from '../../config/app.js';
import type { Env } from '../../config/env.js';

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
  // A plain field instead of ADR 0017's parameter property: `erasableSyntaxOnly` forbids the latter.
  readonly key: string;
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.key = key;
  }
}

export type GetObjectResult =
  | { status: 'ok'; body: Readable; contentType: string; contentLength: number; etag: string; lastModified: Date }
  | { status: 'not-modified'; etag: string };

/** Port used by the upload module and the media route (ADR 0017). Tests pass `createFakeStorage()`. */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Throws ObjectNotFoundError for NoSuchKey/NotFound. `ifNoneMatch` → S3 IfNoneMatch; a 304 maps to 'not-modified'. */
  get(key: string, options?: { ifNoneMatch?: string }): Promise<GetObjectResult>;
  /** Idempotent: deleting a missing key resolves. */
  delete(key: string): Promise<void>;
  isReady(): Promise<boolean>;
}

type S3Env = Pick<
  Env,
  'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'
>;

/** The commands the adapter sends; lets unit tests replace the client with a function. */
export type S3Command = PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadBucketCommand;
export type S3Send = (command: S3Command, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

function isNotModified(error: unknown): boolean {
  return httpStatusOf(error) === 304;
}

function isMissingObject(error: unknown): boolean {
  return error instanceof NoSuchKey || error instanceof NotFound || httpStatusOf(error) === 404;
}

/** One entity tag, strong or weak (RFC 9110 §8.8.3), as opposed to a list or `*`. */
const SINGLE_ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/;

/**
 * The object's current ETag on a 304. S3 sends it as a header (RFC 9110 §15.4.5) and the SDK keeps the raw response
 * on the error. Without that header, a single tag in If-None-Match is the one S3 matched; a list or `*` says nothing
 * about which tag is current, so that response is unusable.
 */
function notModifiedEtag(key: string, error: unknown, ifNoneMatch: string): string {
  const header = error instanceof S3ServiceException ? error.$response?.headers['etag'] : undefined;
  if (header !== undefined && header !== '') return header;
  const requested = ifNoneMatch.trim();
  if (SINGLE_ENTITY_TAG.test(requested)) return requested;
  throw new Error(`304 without an ETag for ${key}`, { cause: error });
}

/** S3 returns ETags quoted; HTTP clients echo them quoted in If-None-Match. Keep the quotes on both sides. */
function okResult(key: string, out: GetObjectCommandOutput): GetObjectResult {
  const { Body, ContentType, ContentLength, ETag, LastModified } = out;
  if (!(Body instanceof Readable) || ContentLength === undefined || ETag === undefined || LastModified === undefined) {
    if (Body instanceof Readable) Body.destroy();
    throw new Error(`Incomplete GetObject response for ${key}`);
  }
  return {
    status: 'ok',
    body: Body,
    contentType: ContentType ?? 'application/octet-stream',
    contentLength: ContentLength,
    etag: ETag,
    lastModified: LastModified,
  };
}

/** The adapter over any `send` function: the real S3 client in production, a stub in unit tests. */
export function createS3ObjectStorage(send: S3Send, bucket: string): ObjectStorage {
  const Bucket = bucket;
  return {
    async put(key, body, contentType) {
      // No ACL parameter: the bucket is private and objects are delivered through the API media route (B-08).
      await send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key, options = {}) {
      try {
        const out = (await send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
          }),
        )) as GetObjectCommandOutput;
        return okResult(key, out);
      } catch (error) {
        if (isNotModified(error) && options.ifNoneMatch !== undefined) {
          return { status: 'not-modified', etag: notModifiedEtag(key, error, options.ifNoneMatch) };
        }
        if (isMissingObject(error)) throw new ObjectNotFoundError(key);
        throw error;
      }
    },
    async delete(key) {
      await send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async isReady() {
      try {
        // Bounded like every readiness check (incl. SDK retries), so a hanging endpoint cannot pile up requests.
        await send(new HeadBucketCommand({ Bucket }), {
          abortSignal: AbortSignal.timeout(READINESS_MS.checkTimeoutMs),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

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
  // S3Client.send is generic per command; narrowing each command lets TypeScript pick the matching overload.
  const send: S3Send = (command, options) => {
    if (command instanceof PutObjectCommand) return client.send(command, options);
    if (command instanceof GetObjectCommand) return client.send(command, options);
    if (command instanceof DeleteObjectCommand) return client.send(command, options);
    return client.send(command, options);
  };
  return {
    ...createS3ObjectStorage(send, env.S3_BUCKET),
    destroy() {
      client.destroy();
    },
  };
}
