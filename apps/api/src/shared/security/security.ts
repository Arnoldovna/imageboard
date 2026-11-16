import type { RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import helmet from 'helmet';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import { AppError } from '../errors/app-error.js';
import type { RedisClient } from '../redis/redis.js';

/** helmet defaults for the JSON API. The SPA's CSP is set by nginx (apps/web/templates/default.conf.template). */
export function securityHeaders(): RequestHandler {
  return helmet();
}

class TooManyRequestsError extends AppError {
  constructor() {
    super({ status: 429, code: 'rate-limited', title: 'Too many requests', detail: 'Please slow down.' });
  }
}

/** A store factory: each limiter needs its own store with a distinct prefix. */
export type RateLimitStoreFactory = (name: string) => Store | undefined;

/** Redis-backed limits survive restarts and hold across instances. Keys: `<prefix>:rl:<name>:`. */
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
}

export function rateLimiter({ windowMs, limit, store }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    ...(store ? { store } : {}),
    // Route the rejection through the central error handler so it is a problem+json response.
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError());
    },
  });
}
