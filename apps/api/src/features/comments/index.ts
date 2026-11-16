// Public API of the comments feature (ADR 0017, signatures frozen): list per image, create, delete (API.md §3).
import type { RequestHandler, Router } from 'express';
import type { Logger } from 'pino';

import type { Database } from '../../db/client.js';
import { createCommentsController } from './comments.controller.js';
import { createCommentsRepository } from './comments.repository.js';
import { createCommentsRouter, createImageCommentsRouter } from './comments.routes.js';
import { createCommentsService } from './comments.service.js';

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

/**
 * Wires repository → service → controller → routers. Builds objects only: nothing connects, queries or throws here,
 * so importing the module and creating it is always safe (ADR 0021 §2). `logger` is part of the frozen deps; request
 * logging and error logging happen centrally (pino-http, problem handler), so the module needs no logger of its own.
 */
export function createCommentsModule(deps: CommentsModuleDeps): CommentsModule {
  const service = createCommentsService({
    repository: createCommentsRepository(deps.db),
    // The images module's `exists`, injected by app.ts (features never import each other, OVERVIEW §6).
    imageExists: (id) => deps.imageExists(id),
  });
  const controller = createCommentsController({ service, pageSize: deps.pageSize });
  return {
    imageCommentsRouter: createImageCommentsRouter({ controller, limiters: deps.limiters }),
    commentsRouter: createCommentsRouter({ controller, limiters: deps.limiters }),
  };
}
