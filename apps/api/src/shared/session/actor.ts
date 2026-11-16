import type { Request, RequestHandler } from 'express';

import { ForbiddenError } from '../errors/app-error.js';

declare module 'express-session' {
  interface SessionData {
    /** Anonymous identity (UUID v4), stored as `owner_id` on everything this session creates (ADR 0002). */
    ownerId: string;
    /** True after the first successful upload or comment: the session has its full lifetime. */
    active: boolean;
  }
}

/** Cookie and Redis lifetimes of a session, in milliseconds (SESSION_PROVISIONAL_HOURS, SESSION_MAX_AGE_DAYS). */
export interface SessionLifetimes {
  provisionalMs: number;
  fullMs: number;
}

declare global {
  // Express merges this global interface into its Request type.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the declaration-merging hook Express provides
  namespace Express {
    interface Request {
      /** Set by the session middleware (`shared/security/session.ts`) on every request. */
      sessionLifetimes?: SessionLifetimes;
    }
  }
}

/** Who is acting. `ownerId` is null for a visitor without an anonymous identity (no `GET /api/session` yet). */
export interface Actor {
  ownerId: string | null;
}

/** Only valid behind the session middleware (every `/api` route except health and media). */
export function actorOf(req: Request): Actor {
  return { ownerId: req.session.ownerId ?? null };
}

/** Guards mutations: 403 `session-required` when the visitor has no anonymous identity (OVERVIEW §11). */
export const requireOwnerSession: RequestHandler = (req, _res, next) => {
  if (actorOf(req).ownerId === null) {
    next(new ForbiddenError('session-required'));
    return;
  }
  next();
};

/**
 * Promotes a provisional session to the full SESSION_MAX_AGE_DAYS lifetime (ADR 0002, F-34). The images and
 * comments controllers call it after a `201`, before the response is sent, so the same response carries the new
 * cookie `Max-Age` and connect-redis stores the session with the longer TTL.
 */
export function markSessionActive(req: Request): void {
  const lifetimes = req.sessionLifetimes;
  if (lifetimes === undefined) throw new Error('markSessionActive needs the session middleware');
  req.session.active = true;
  req.session.cookie.maxAge = lifetimes.fullMs;
}
