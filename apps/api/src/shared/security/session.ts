import { RedisStore } from 'connect-redis';
import type { RequestHandler } from 'express';
import session from 'express-session';

import { appCookieName } from '../../config/app.js';
import type { RedisClient } from '../redis/redis.js';
import type { SessionLifetimes } from '../session/actor.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SessionOptions {
  redis: RedisClient;
  secret: string;
  /** true in production (HTTPS). Adds `Secure` and the `__Host-` cookie prefix. */
  secure: boolean;
  /** Redis key prefix: APP_SLUG in production, a fresh `test-<uuid>` per test app. Keys: `<prefix>:sess:<id>`. */
  prefix: string;
  lifetimes: SessionLifetimes;
}

/** SESSION_PROVISIONAL_HOURS / SESSION_MAX_AGE_DAYS in milliseconds (ADR 0002). */
export function sessionLifetimes(env: {
  SESSION_PROVISIONAL_HOURS: number;
  SESSION_MAX_AGE_DAYS: number;
}): SessionLifetimes {
  return { provisionalMs: env.SESSION_PROVISIONAL_HOURS * HOUR_MS, fullMs: env.SESSION_MAX_AGE_DAYS * DAY_MS };
}

/**
 * Anonymous sessions (ADR 0002): Redis store, signed cookie that holds only the session id, `HttpOnly`,
 * `SameSite=Lax`, `Path=/`, `Secure` in production. `saveUninitialized: false`, so a session is stored only once
 * `GET /api/session` puts an `ownerId` into it.
 *
 * Every new session starts **provisional** (cookie and Redis TTL = `lifetimes.provisionalMs`); `markSessionActive`
 * raises it to `lifetimes.fullMs` after the first upload or comment. `rolling: true` renews whichever lifetime the
 * session has on every response, and connect-redis derives the key TTL from the cookie expiry.
 */
export function createSessionMiddleware({ redis, secret, secure, prefix, lifetimes }: SessionOptions): RequestHandler {
  const middleware = session({
    store: new RedisStore({ client: redis, prefix: `${prefix}:sess:` }),
    name: appCookieName('sid', secure),
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: lifetimes.provisionalMs,
    },
  });
  return (req, res, next) => {
    // markSessionActive (shared/session/actor.ts) reads the configured full lifetime from here.
    req.sessionLifetimes = lifetimes;
    middleware(req, res, next);
  };
}
