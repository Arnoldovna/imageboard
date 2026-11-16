// Public API of the session feature: the anonymous identity and `GET /api/session` (ADR 0002, ADR 0003).
// The helpers other features use (actorOf, requireOwnerSession, markSessionActive) live in shared/session/actor.ts.
import type { Request, RequestHandler, Response, Router } from 'express';

import { createSessionController } from './session.controller.js';
import { createSessionRouter } from './session.routes.js';
import { createSessionService } from './session.service.js';

export interface SessionModuleDeps {
  /** `identities` limiter (RATE_LIMIT_IDENTITIES per hour per IP), applied only when a new identity is created. */
  identityLimiter: RequestHandler;
  issueCsrfToken: (req: Request, res: Response) => string;
  /** UPLOAD_MAX_BYTES, sent to the SPA for its client-side size check. */
  uploadMaxBytes: number;
  newOwnerId?: () => string;
}

export interface SessionModule {
  router: Router; // mounted at /api/session
}

export function createSessionModule({
  identityLimiter,
  issueCsrfToken,
  uploadMaxBytes,
  newOwnerId,
}: SessionModuleDeps): SessionModule {
  const service = createSessionService(newOwnerId ? { newOwnerId } : {});
  const controller = createSessionController({ service, issueCsrfToken, uploadMaxBytes });
  return { router: createSessionRouter({ controller, identityLimiter }) };
}
