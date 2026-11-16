import { type RequestHandler, Router } from 'express';

import type { SessionController } from './session.controller.js';

export interface SessionRouteDeps {
  controller: SessionController;
  identityLimiter: RequestHandler;
}

/** Mounted at `/api/session`, after the session middleware and the global limiter, before CSRF protection. */
export function createSessionRouter({ controller, identityLimiter }: SessionRouteDeps): Router {
  const router = Router({ caseSensitive: true });
  router.get('/', controller.limitNewIdentities(identityLimiter), controller.show);
  return router;
}
