import { type RequestHandler, Router } from 'express';

import { noStore } from '../../shared/http/no-store.js';
import { requireJson } from '../../shared/http/require-json.js';
import { requireOwnerSession } from '../../shared/session/actor.js';
import type { CommentsController } from './comments.controller.js';

export interface CommentsRouteDeps {
  controller: CommentsController;
  limiters: { comments: RequestHandler; deletes: RequestHandler };
}

/*
 * App-level middleware runs first (OVERVIEW §4.1): global limiter, fetch-metadata guard, JSON body parser (16 KB),
 * session and, for POST/DELETE, CSRF. Each router marks every response `no-store` (API JSON, errors included). Per
 * route: the identity guard, then the route's limiter (a visitor without an identity never uses up a budget), then the
 * content-type gate, then the controller.
 */

/** Mounted at `/api/images/:imageId/comments`; `mergeParams` exposes `imageId` from the mount path. */
export function createImageCommentsRouter({ controller, limiters }: CommentsRouteDeps): Router {
  const router = Router({ caseSensitive: true, mergeParams: true });
  router.use(noStore);
  router.get('/', controller.list);
  router.post('/', requireOwnerSession, limiters.comments, requireJson, controller.create);
  return router;
}

/** Mounted at `/api/comments`. The `deletes` limiter is the instance shared with `DELETE /api/images/:id`. */
export function createCommentsRouter({ controller, limiters }: CommentsRouteDeps): Router {
  const router = Router({ caseSensitive: true });
  router.use(noStore);
  router.delete('/:id', requireOwnerSession, limiters.deletes, controller.remove);
  return router;
}
