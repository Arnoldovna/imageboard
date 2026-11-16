// Public API of the comments feature (ADR 0017, signatures frozen). Phase 1b stub: phase 2.3 replaces the bodies
// (list per image, create, delete) without changing the exported types.
import { type RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';

export interface CommentsModuleDeps {
  db: Database;
  logger: Logger;
  imageExists(id: number): Promise<boolean>;
  limiters: { comments: RequestHandler; deletes: RequestHandler };
  pageSize: number; // COMMENTS_PAGE_SIZE
}

export interface CommentsModule {
  imageCommentsRouter: Router; // mounted at /api/images/:imageId/comments (mergeParams)
  commentsRouter: Router; // mounted at /api/comments
}

export function createCommentsModule(_deps: CommentsModuleDeps): CommentsModule {
  // No routes yet: both mount points fall through to the 404 problem handler.
  return { imageCommentsRouter: Router({ mergeParams: true }), commentsRouter: Router() };
}
