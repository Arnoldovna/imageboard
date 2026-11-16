import type { RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import helmet from 'helmet';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import { TooManyRequestsError } from '../errors/app-error.js';
import type { RedisClient } from '../redis/redis.js';

export interface SecurityHeaderOptions {
  /** HSTS only when the deployment is HTTPS (production); local http stacks must not pin HSTS on 127.0.0.1. */
  hsts: boolean;
}

/**
 * helmet for the JSON API (F-42, B-10). API responses are data, never documents, so the CSP forbids everything.
 * The SPA's CSP comes from nginx (apps/web/templates/default.conf.template); the media route sets its own sandbox
 * CSP (ADR 0004). CORP stays `same-origin`; there is no CORS middleware (ADR 0003).
 */
export function securityHeaders({ hsts }: SecurityHeaderOptions): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
}

/** A store factory: each limiter needs its own store with a distinct prefix. */
export type RateLimitStoreFactory = (name: string) => Store | undefined;

/** Redis-backed limits survive restarts and hold across instances. Keys: `<prefix>:rl:<name>:<client key>`. */
export function redisRateLimitStores(redis: RedisClient, prefix: string): RateLimitStoreFactory {
  return (name) =>
    new RedisStore({
      prefix: `${prefix}:rl:${name}:`,
      sendCommand: (...args: string[]) => redis.sendCommand<RedisReply>(args),
    });
}

/** In-memory stores (express-rate-limit default) for unit tests. */
export const memoryRateLimitStores: RateLimitStoreFactory = () => undefined;

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  store?: Store | undefined;
  /**
   * `ip` (default): per client address, IPv6 grouped by /56. `global`: one shared budget for all clients (the daily
   * upload cap, ADR 0013/0019).
   */
  scope?: 'ip' | 'global';
}

const GLOBAL_KEY = 'all';

/**
 * express-rate-limit 8 with IETF draft-8 `RateLimit`/`RateLimit-Policy` headers and `Retry-After` on 429. The
 * rejection goes through the central error handler, so it is a `429 rate-limited` problem (F-40, B-09).
 */
export function rateLimiter({ windowMs, limit, store, scope = 'ip' }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // A custom keyGenerator disables ipv6Subnet (conventions §8), so the global key sets only the generator.
    ...(scope === 'global' ? { keyGenerator: () => GLOBAL_KEY } : { ipv6Subnet: 56 }),
    ...(store ? { store } : {}),
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError());
    },
  });
}
