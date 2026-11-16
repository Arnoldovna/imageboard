import { pipeline } from 'node:stream/promises';

import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { NotFoundError } from '../../shared/errors/app-error.js';
import { type GetObjectResult, ObjectNotFoundError, type ObjectStorage } from '../../shared/storage/object-storage.js';
import { MEDIA_FILE_PATTERN, ORIGINALS_PREFIX, PREVIEW_FILE_PATTERN, PREVIEWS_PREFIX } from './object-key.js';
import { MEDIA_HEADERS } from './upload.config.js';

export interface MediaControllerDeps {
  storage: ObjectStorage;
}

/** `:file` of each media route. Anything else is a 404 without a storage call (API.md §4, ADR 0004). */
const OriginalParams = z.object({ file: z.string().regex(MEDIA_FILE_PATTERN) });
const PreviewParams = z.object({ file: z.string().regex(PREVIEW_FILE_PATTERN) });

interface MediaKind {
  params: typeof OriginalParams;
  prefix: string;
}

const ORIGINAL: MediaKind = { params: OriginalParams, prefix: ORIGINALS_PREFIX };
const PREVIEW: MediaKind = { params: PreviewParams, prefix: PREVIEWS_PREFIX };

/** Headers of every 200 and 304 (RFC 9110 §15.4.5: a 304 repeats ETag and Cache-Control). */
function setCacheHeaders(res: Response, etag: string): void {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', MEDIA_HEADERS.cacheControl);
}

/**
 * The stored bytes are served as data, never as a document (B-05): the stored (detected) type, nosniff, a sandbox CSP
 * that overrides the API's, inline disposition and same-origin CORP.
 */
function setObjectHeaders(res: Response, object: Extract<GetObjectResult, { status: 'ok' }>): void {
  setCacheHeaders(res, object.etag);
  // setHeader, not res.type(): the stored value is sent exactly as stored.
  res.setHeader('Content-Type', object.contentType);
  res.setHeader('Content-Length', String(object.contentLength));
  res.setHeader('Last-Modified', object.lastModified.toUTCString());
  res.setHeader('Content-Disposition', MEDIA_HEADERS.contentDisposition);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', MEDIA_HEADERS.contentSecurityPolicy);
  res.setHeader('Cross-Origin-Resource-Policy', MEDIA_HEADERS.crossOriginResourcePolicy);
}

function isClientAbort(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

async function getObject(storage: ObjectStorage, key: string, ifNoneMatch: string | undefined) {
  try {
    return await storage.get(key, ifNoneMatch === undefined ? {} : { ifNoneMatch });
  } catch (error) {
    // Deleted or never stored (F-36, B-07). Any other storage failure stays a 500.
    if (error instanceof ObjectNotFoundError) throw new NotFoundError('Image');
    throw error;
  }
}

/**
 * `GET`/`HEAD /api/media/{images,previews}/:file` (ADR 0004, 0018). Express answers HEAD with the GET handler; for
 * HEAD the headers are written and the storage stream is destroyed unread.
 */
export function createMediaController({ storage }: MediaControllerDeps) {
  const serve =
    (kind: MediaKind): RequestHandler =>
    async (req: Request, res: Response) => {
      const parsed = kind.params.safeParse(req.params);
      if (!parsed.success) throw new NotFoundError('Image');
      const key = `${kind.prefix}/${parsed.data.file}`;
      const ifNoneMatch = req.get('if-none-match')?.trim();

      const object = await getObject(storage, key, ifNoneMatch === '' ? undefined : ifNoneMatch);
      if (object.status === 'not-modified') {
        setCacheHeaders(res, object.etag);
        res.status(304).end();
        return;
      }

      setObjectHeaders(res, object);
      if (req.method === 'HEAD') {
        object.body.destroy();
        res.status(200).end();
        return;
      }
      res.status(200);
      await pipeline(object.body, res).catch((error: unknown) => {
        // pipeline has destroyed both streams, so no problem body can follow the headers already sent.
        if (isClientAbort(error)) {
          req.log.debug({ key }, 'client closed the media response early');
        } else {
          req.log.error({ err: error, key }, 'streaming a media object failed');
        }
      });
    };

  return { original: serve(ORIGINAL), preview: serve(PREVIEW) };
}

export type MediaController = ReturnType<typeof createMediaController>;
