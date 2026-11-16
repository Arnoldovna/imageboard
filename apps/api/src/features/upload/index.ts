// Public API of the upload feature (ADR 0017, signatures frozen). Phase 1b stub: phase 2.1 replaces the bodies
// (sniffer, sharp pipeline, preview, object keys, media routes) without changing the exported types.
import { type RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { ImageUploadPort } from '../../shared/ports/image-upload.js';
import type { ObjectStorage } from '../../shared/storage/object-storage.js';

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

const STUB_MESSAGE = 'upload module is a scaffold stub (implemented in phase 2.1)';

const notImplemented = (): Promise<never> => Promise.reject(new Error(STUB_MESSAGE));

function notImplementedSync(): never {
  throw new Error(STUB_MESSAGE);
}

export function createUploadModule(_deps: UploadModuleDeps): UploadModule {
  return {
    port: {
      ingest: notImplemented,
      discard: () => Promise.resolve(),
      publicUrl: notImplementedSync,
      previewUrl: notImplementedSync,
    },
    // No routes yet: /api/media/* falls through to the 404 problem handler.
    mediaRouter: Router(),
  };
}
