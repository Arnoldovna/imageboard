import type { SessionDto } from '@app/shared';
import type { Request, RequestHandler, Response } from 'express';

import type { SessionService } from './session.service.js';

export interface SessionControllerDeps {
  service: SessionService;
  /** csrf-csrf `generateCsrfToken`, bound to `req.session.id` (ADR 0003). */
  issueCsrfToken: (req: Request, res: Response) => string;
  uploadMaxBytes: number;
}

export function createSessionController({ service, issueCsrfToken, uploadMaxBytes }: SessionControllerDeps) {
  /**
   * `GET /api/session` (API.md §1): ensure the anonymous identity, then issue a CSRF token for this session. Storing
   * `ownerId` makes the session persistent, so its id (and with it the token) stays stable. A second call returns a
   * token that is valid for the same session.
   */
  const show: RequestHandler = (req, res) => {
    service.ensureIdentity(req.session);
    const body: SessionDto = { csrfToken: issueCsrfToken(req, res), uploadMaxBytes };
    res.set('Cache-Control', 'no-store').json(body);
  };

  /**
   * The identity limiter counts only requests that are about to create a new identity; an existing session never
   * uses up the budget (ADR 0002, ADR 0013).
   */
  const limitNewIdentities =
    (identityLimiter: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      if (service.hasIdentity(req.session)) {
        next();
        return;
      }
      // Awaited so a limiter failure (e.g. Redis down) reaches the error handler through Express 5.
      await identityLimiter(req, res, next);
    };

  return { show, limitNewIdentities };
}

export type SessionController = ReturnType<typeof createSessionController>;
