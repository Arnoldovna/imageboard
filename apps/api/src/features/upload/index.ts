// Public API of the upload feature (ADR 0017, signatures frozen): the `ImageUploadPort` the images module receives
// (sniff, sharp pipeline, preview, object keys, storage) and the media router mounted at /api/media.
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { ImageUploadPort } from '../../shared/ports/image-upload.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';
import { createImageProcessor } from './image-processor.js';
import { createMediaController } from './media.controller.js';
import { createMediaRouter } from './media.routes.js';
import { MAX_ANIMATION_PIXELS } from './upload.config.js';
import { createUploadService } from './upload.service.js';

/** `images/<uuid>.<ext>` → `previews/<uuid>.webp` (ADR 0018). Pure; the seed scripts use it to check both objects. */
export { previewKeyOf } from './object-key.js';

export interface UploadConfig {
  maxPixels: number; // UPLOAD_MAX_PIXELS, per frame
  maxFrames: number; // UPLOAD_MAX_FRAMES
  maxEdge: number; // IMAGE_MAX_EDGE
  mediaPublicBaseUrl: string;
}

export interface UploadModuleDeps {
  storage: ObjectStorage;
  logger: Logger;
  config: UploadConfig;
  mediaLimiter: RequestHandler;
  sleep?: (ms: number) => Promise<void>; // injected in tests to skip retry backoff
}

export interface UploadModule {
  port: ImageUploadPort;
  mediaRouter: Router;
}

/** Builds the module without touching the network: storage is used only when a request or `ingest` runs. */
export function createUploadModule({ storage, logger, config, mediaLimiter, sleep }: UploadModuleDeps): UploadModule {
  const port = createUploadService({
    storage,
    logger,
    processor: createImageProcessor({ ...config, maxAnimationPixels: MAX_ANIMATION_PIXELS }),
    mediaPublicBaseUrl: config.mediaPublicBaseUrl,
    ...(sleep ? { sleep } : {}),
  });
  const mediaRouter = createMediaRouter({ controller: createMediaController({ storage }), mediaLimiter });
  return { port, mediaRouter };
}
