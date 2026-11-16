import type { Request, RequestHandler } from 'express';

import { ForbiddenError } from '../errors/app-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

export interface FetchMetadataOptions {
  /** APP_ORIGIN. Unset: the request's own origin (`req.protocol` + `Host`, which relies on TRUST_PROXY). */
  appOrigin?: string | undefined;
}

function ownOrigin(req: Request): string | undefined {
  const host = req.get('host');
  return host === undefined ? undefined : `${req.protocol}://${host}`;
}

/** Origins compare by their serialisation (`new URL().origin` lowercases and drops default ports). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Fetch Metadata guard, defence in depth next to the CSRF token and SameSite=Lax (ADR 0003, B-03). For unsafe
 * methods:
 * - `Sec-Fetch-Site` present → must be `same-origin` or `none`;
 * - otherwise `Origin` present → must equal APP_ORIGIN (when set) or the request's own origin (`null` never passes);
 * - neither header (curl, Supertest, very old browsers) → passes on to the CSRF check.
 * Violations are `403 cross-origin-request`.
 */
export function createFetchMetadataGuard({ appOrigin }: FetchMetadataOptions = {}): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite !== undefined) {
      next(ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase()) ? undefined : new ForbiddenError('cross-origin-request'));
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      const expected = appOrigin ?? ownOrigin(req);
      const allowed = expected !== undefined && origin !== 'null' && sameOrigin(origin, expected);
      next(allowed ? undefined : new ForbiddenError('cross-origin-request'));
      return;
    }
    next();
  };
}
