// Public API of the images feature (ADR 0017, signatures frozen): list, get, create and delete under /api/images,
// plus `exists` for the comments module and `adminRemove` for the takedown script (ADR 0019).
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import type { ImageUploadPort } from '../../shared/ports/image-upload.js';
import { createImagesController } from './images.controller.js';
import { createImagesRepository } from './images.repository.js';
import { createImagesRouter } from './images.routes.js';
import { createImagesService } from './images.service.js';

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

/** Wires repository → service → controller → router. Opens no connections and never throws (ADR 0021 §2). */
export function createImagesModule({
  db,
  logger,
  upload,
  parseMultipart,
  limiters,
  pageSize,
}: ImagesModuleDeps): ImagesModule {
  const service = createImagesService({ repository: createImagesRepository(db), upload, logger });
  const controller = createImagesController({ service, pageSize });
  return {
    router: createImagesRouter({ controller, parseMultipart, limiters }),
    exists: (id) => service.exists(id),
    adminRemove: (id) => service.adminRemove(id),
  };
}
