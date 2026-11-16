import express, { type Express } from 'express';
import type { Logger } from 'pino';

import { RATE_LIMIT_WINDOWS_MS } from './config/app.js';
import type { Env } from './config/env.js';
import { createHealthRouter, type ReadinessCheck } from './shared/http/health.js';
import { errorHandler, notFoundHandler } from './shared/http/problem.js';
import { createRequestLogger } from './shared/logging/logger.js';
import { rateLimiter, type RateLimitStoreFactory, securityHeaders } from './shared/security/security.js';

/** Everything the app needs from the outside world. Tests pass Testcontainers-backed or fake implementations. */
export interface AppDeps {
  env: Env;
  logger: Logger;
  rateLimitStores: RateLimitStoreFactory;
  readiness: Readonly<Record<string, ReadinessCheck>>;
  isShuttingDown: () => boolean;
}

/**
 * Phase 1a skeleton: request logging, internal health, security headers, the global limiter, body limit and the
 * problem+json fallbacks. Phase 1b adds sessions, CSRF, the fetch-metadata guard and the feature modules (OVERVIEW §4.1).
 */
export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(createRequestLogger(deps.logger));
  app.use('/api/health', createHealthRouter({ checks: deps.readiness, isShuttingDown: deps.isShuttingDown }));

  app.use(securityHeaders());
  // The global limiter runs before body parsing: a request is counted (and rejected when over budget) before its body
  // is read, and a malformed or oversized JSON body, which ends the chain with next(err), still uses up budget.
  app.use(
    '/api',
    rateLimiter({
      windowMs: RATE_LIMIT_WINDOWS_MS.global,
      limit: env.RATE_LIMIT_GLOBAL,
      store: deps.rateLimitStores('global'),
    }),
  );
  app.use(express.json({ limit: '16kb', strict: true }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
