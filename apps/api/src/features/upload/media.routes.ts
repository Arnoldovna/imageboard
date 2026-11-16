import { type RequestHandler, Router } from 'express';

import type { MediaController } from './media.controller.js';

export interface MediaRouteDeps {
  controller: MediaController;
  /** RATE_LIMIT_MEDIA per 5 min per IP; media requests are not counted by the global limiter (ADR 0013). */
  mediaLimiter: RequestHandler;
}

/**
 * Mounted at `/api/media`, after helmet and before the global limiter, the session and CSRF (ADR 0004): no Redis
 * session read per image. Two literal routes, because Express 5 has no inline regex parameters; GET also answers
 * HEAD. Any other path falls through to the app's 404 handling.
 */
export function createMediaRouter({ controller, mediaLimiter }: MediaRouteDeps): Router {
  const router = Router({ caseSensitive: true });
  router.get('/images/:file', mediaLimiter, controller.original);
  router.get('/previews/:file', mediaLimiter, controller.preview);
  return router;
}
