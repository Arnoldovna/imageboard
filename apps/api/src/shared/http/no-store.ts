import type { RequestHandler } from 'express';

/**
 * API JSON is never cached (API.md §0): it carries the per-session `canDelete`. Mounted on a router before its
 * handlers, so problem responses (400, 403, 404, 429) carry the header as well, not only the successful ones.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};
