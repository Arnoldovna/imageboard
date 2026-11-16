import { type RequestHandler, Router } from 'express';

import { noStore } from '../../shared/http/no-store.js';
import { requireOwnerSession } from '../../shared/session/actor.js';
import type { ImagesController } from './images.controller.js';

export interface ImagesRouteDeps {
  controller: ImagesController;
  /** The shared multipart parser (`createMultipartParser({ maxFileBytes: UPLOAD_MAX_BYTES })`, ADR 0017). */
  parseMultipart: RequestHandler;
  limiters: { uploads: RequestHandler; uploadsGlobalDay: RequestHandler; deletes: RequestHandler };
}

/**
 * Mounted at `/api/images`, behind the global limiter, the fetch-metadata guard, the session and CSRF protection
 * (app.ts). Mutations then need an anonymous identity before any per-route budget is used or any body is parsed:
 * `POST /` runs `requireOwnerSession` → uploads limiter → global daily upload cap → multipart parser → controller
 * (ADR 0017); `DELETE /:id` runs `requireOwnerSession` → deletes limiter → controller.
 */
export function createImagesRouter({ controller, parseMultipart, limiters }: ImagesRouteDeps): Router {
  const router = Router({ caseSensitive: true });
  router.use(noStore);
  router.get('/', controller.list);
  router.get('/:id', controller.show);
  router.post('/', requireOwnerSession, limiters.uploads, limiters.uploadsGlobalDay, parseMultipart, controller.create);
  router.delete('/:id', requireOwnerSession, limiters.deletes, controller.remove);
  return router;
}
