import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';

import { appCookieName } from '../../config/app.js';

export interface CsrfOptions {
  secret: string;
  secure: boolean;
}

/**
 * Signed double-submit cookie bound to the session id (ADR 0003). The SPA sends the token in `x-csrf-token`; there
 * is no form fallback. Ignored methods: GET, HEAD, OPTIONS. `cookie-parser` must run after express-session and before
 * `doubleCsrfProtection`. The session id is stable because `GET /api/session` stores an `ownerId` before it issues
 * the token (with `saveUninitialized: false` an empty session would get a new id on every request).
 * A rejected token is an `http-errors` 403 with code `EBADCSRFTOKEN`, mapped to `csrf-invalid` by the problem handler.
 */
export function createCsrf({ secret, secure }: CsrfOptions): DoubleCsrfUtilities {
  return doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: (req) => req.session.id,
    cookieName: appCookieName('x-csrf-token', secure),
    cookieOptions: { sameSite: 'lax', path: '/', secure, httpOnly: true },
    getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
  });
}
