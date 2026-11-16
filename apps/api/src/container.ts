import type { Logger } from 'pino';

import { APP_SLUG } from './config/app.js';
import type { Env } from './config/env.js';
import { createDatabase } from './db/client.js';
import { connectRedis } from './shared/redis/redis.js';
import { redisRateLimitStores } from './shared/security/security.js';
import { createS3Storage } from './shared/storage/object-storage.js';

/**
 * Composition root: the only place that creates connections. Everything else receives
 * dependencies as arguments, so there are no module-level singletons to reset in tests.
 */
export async function createContainer(env: Env, logger: Logger) {
  const database = createDatabase(env.DATABASE_URL, logger);
  const redis = await connectRedis(env.REDIS_URL, 'sessions', logger);
  // Production may keep limiter counters in a separate Redis (ADR 0002); locally both share one instance.
  const limiterRedis = env.RATE_LIMIT_REDIS_URL
    ? await connectRedis(env.RATE_LIMIT_REDIS_URL, 'rate-limits', logger)
    : redis;
  const storage = createS3Storage(env);

  return {
    rateLimitStores: redisRateLimitStores(limiterRedis, APP_SLUG),
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady && limiterRedis.isReady),
      storage: () => storage.isReady(),
    },
    async dispose(): Promise<void> {
      const clients = limiterRedis === redis ? [redis] : [redis, limiterRedis];
      // allSettled: one failing close must not keep the others open; failures are logged, never swallowed.
      const results = await Promise.allSettled([database.close(), ...clients.map((client) => client.close())]);
      for (const result of results) {
        if (result.status === 'rejected') logger.error({ err: result.reason }, 'closing a connection failed');
      }
      storage.destroy();
    },
  };
}
