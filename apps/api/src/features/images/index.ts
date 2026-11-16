// Public API of the images feature (ADR 0017, signatures frozen). Phase 1b stub: phase 2.2 replaces the bodies
// (list, get, create, delete, exists, adminRemove) without changing the exported types.
import { type RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { ImageUploadPort } from '../../shared/ports/image-upload.js';

export interface ImagesModuleDeps {
  db: Database;
  logger: Logger;
  upload: ImageUploadPort;
  parseMultipart: RequestHandler; // createMultipartParser({ maxFileBytes: UPLOAD_MAX_BYTES })
  limiters: { uploads: RequestHandler; uploadsGlobalDay: RequestHandler; deletes: RequestHandler };
  pageSize: number; // IMAGES_PAGE_SIZE
}

export interface ImagesModule {
  router: Router; // mounted at /api/images
  exists(id: number): Promise<boolean>;
  /** Admin script only (ADR 0019): delete regardless of owner, then discard the objects. */
  adminRemove(id: number): Promise<'removed' | 'not-found'>;
}

const notImplemented = (): Promise<never> =>
  Promise.reject(new Error('images module is a scaffold stub (implemented in phase 2.2)'));

export function createImagesModule(_deps: ImagesModuleDeps): ImagesModule {
  return {
    // No routes yet: /api/images/* falls through to the 404 problem handler.
    router: Router(),
    exists: notImplemented,
    adminRemove: notImplemented,
  };
}
