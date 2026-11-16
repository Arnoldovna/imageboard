import type { ImageMimeType } from '@app/shared';
import type { Logger } from 'pino';

import type { ImageUploadPort, IncomingFile, IngestOptions, StoredImage } from '../../shared/ports/image-upload.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';
import type { ImageProcessor } from './image-processor.js';
import { sniffImageType } from './image-sniffer.js';
import { EXTENSION_BY_TYPE, newObjectKey, parseObjectKey, previewKeyOf } from './object-key.js';
import { DISCARD_RETRY, PREVIEW } from './upload.config.js';

export interface UploadServiceDeps {
  storage: ObjectStorage;
  logger: Logger;
  processor: ImageProcessor;
  /** MEDIA_PUBLIC_BASE_URL, e.g. `/api/media` or a CDN origin (ADR 0019). */
  mediaPublicBaseUrl: string;
  /** Waits between delete attempts; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** Seam for tests that need a known key. */
  newUuid?: () => string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The seed passes a fixed key from its manifest (ADR 0014). It must be an original's key whose extension is the one of
 * the detected type, or the DB CHECK `images_object_key_matches_mime` would reject the row after the objects exist.
 * A mismatch is a broken manifest, not a client error, so it is a plain Error (500).
 */
function fixedObjectKey(objectKey: string, mimeType: ImageMimeType): string {
  const parsed = parseObjectKey(objectKey);
  if (parsed === undefined) throw new Error(`Fixed object key does not match MEDIA_KEY_PATTERN: ${objectKey}`);
  if (parsed.extension !== EXTENSION_BY_TYPE[mimeType]) {
    throw new Error(`Fixed object key ${objectKey} does not match the detected type ${mimeType}`);
  }
  return objectKey;
}

/**
 * `ImageUploadPort` (ADR 0017): sniff → inspect/decode/normalise + preview → put original → put preview. Every check
 * that can fail runs before the first put, and a failed put removes whatever may have been stored, so a rejected
 * `ingest` leaves nothing behind (F-23, ADR 0008). Storage errors are awaited and rethrown, never emitted on an
 * unhandled stream (B-19).
 */
export function createUploadService(deps: UploadServiceDeps): ImageUploadPort {
  const { storage, processor } = deps;
  const logger = deps.logger.child({ feature: 'upload' });
  const sleep = deps.sleep ?? defaultSleep;
  const baseUrl = deps.mediaPublicBaseUrl.replace(/\/+$/, '');

  /** One key with the retry policy. Resolves with whether the key is gone; never rejects. */
  async function deleteWithRetry(key: string): Promise<{ key: string; deleted: boolean; error?: unknown }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DISCARD_RETRY.attempts; attempt += 1) {
      try {
        await storage.delete(key);
        return { key, deleted: true };
      } catch (error) {
        lastError = error;
        const delay = DISCARD_RETRY.delaysMs[attempt - 1];
        if (delay !== undefined) await sleep(delay);
      }
    }
    return { key, deleted: false, error: lastError };
  }

  /** Deletes the original and its preview in parallel; logs the keys that are still there (orphans) at `error`. */
  async function removeObjects(objectKey: string, reason: 'discard' | 'failed-ingest'): Promise<void> {
    const objectKeys = [objectKey, previewKeyOf(objectKey)];
    const results = await Promise.all(objectKeys.map((key) => deleteWithRetry(key)));
    const failed = results.filter((result) => !result.deleted);
    if (failed.length > 0) {
      logger.error(
        {
          err: failed[0]?.error,
          objectKey,
          objectKeys,
          failedKeys: failed.map((result) => result.key),
          attempts: DISCARD_RETRY.attempts,
          reason,
        },
        'stored objects could not be deleted (possible orphans)',
      );
    }
  }

  async function putBoth(objectKey: string, mimeType: ImageMimeType, original: Buffer, preview: Buffer) {
    try {
      await storage.put(objectKey, original, mimeType);
      await storage.put(previewKeyOf(objectKey), preview, PREVIEW.contentType);
    } catch (error) {
      // A timed-out put may still have stored the object, so both keys are deleted (idempotent) before rethrowing.
      await removeObjects(objectKey, 'failed-ingest');
      throw error;
    }
  }

  return {
    async ingest(file: IncomingFile, options: IngestOptions = {}): Promise<StoredImage> {
      const mimeType = await sniffImageType(file.buffer);
      const objectKey =
        options.objectKey === undefined
          ? newObjectKey(mimeType, deps.newUuid)
          : fixedObjectKey(options.objectKey, mimeType);
      const processed = await processor.process(file.buffer, mimeType);
      await putBoth(objectKey, mimeType, processed.original, processed.preview);
      return {
        objectKey,
        mimeType,
        width: processed.width,
        height: processed.height,
        sizeBytes: processed.original.byteLength,
      };
    },

    async discard(objectKey) {
      try {
        if (parseObjectKey(objectKey) === undefined) {
          // Keys come from the DB (CHECK constraint), so this is a bug; never delete a key we cannot vouch for.
          logger.error({ objectKey }, 'discard called with a key that is not an image object key');
          return;
        }
        await removeObjects(objectKey, 'discard');
      } catch (error) {
        // The port promises never to throw: the image is already gone from the product (ADR 0008).
        logger.error({ err: error, objectKey }, 'discarding stored objects failed');
      }
    },

    publicUrl(objectKey) {
      return `${baseUrl}/${objectKey}`;
    },

    previewUrl(objectKey) {
      return `${baseUrl}/${previewKeyOf(objectKey)}`;
    },
  };
}
