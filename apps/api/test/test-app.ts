import type { Express } from 'express';
import { pino } from 'pino';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { type EnvKey, loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { connectRedis } from '../src/shared/redis/redis.js';
import { redisRateLimitStores } from '../src/shared/security/security.js';

export interface TestAppOptions {
  /** Merged over the test defaults, which raise every RATE_LIMIT_* to 100000 so no test hits a limiter by accident. */
  env?: Partial<Record<EnvKey, string>>;
  /** Default: the run's database from global-setup. */
  databaseUrl?: string;
}

export interface TestApp {
  app: Express;
  databaseUrl: string;
  close(): Promise<void>;
}

const RAISED_LIMITS = {
  RATE_LIMIT_GLOBAL: '100000',
  RATE_LIMIT_IDENTITIES: '100000',
  RATE_LIMIT_UPLOADS: '100000',
  RATE_LIMIT_UPLOADS_GLOBAL_DAY: '100000',
  RATE_LIMIT_COMMENTS: '100000',
  RATE_LIMIT_DELETES: '100000',
  RATE_LIMIT_MEDIA: '100000',
} satisfies Partial<Record<EnvKey, string>>;

/**
 * Real Postgres + Redis from Testcontainers, silent logger, a fresh Redis prefix per app. It wires `createApp` like
 * `container.ts` does, but with its own prefix and faked storage (ADR 0017); connections go through the same
 * factories (`createDatabase`, `connectRedis`), so their error listeners and timeouts cannot drift from production.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const databaseUrl = options.databaseUrl ?? inject('databaseUrl');
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    REDIS_URL: inject('redisUrl'),
    SESSION_SECRET: 'test-session-secret-at-least-32-chars',
    CSRF_SECRET: 'test-csrf-secret-at-least-32-characters',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    ...RAISED_LIMITS,
    ...options.env,
    DATABASE_URL: databaseUrl,
  });
  const logger = pino({ level: 'silent' });
  const database = createDatabase(env.DATABASE_URL, logger);
  const redis = await connectRedis(env.REDIS_URL, 'test', logger);
  // One fresh Redis prefix per test app: rate-limit counters (and sessions from 1b) never leak between apps.
  const prefix = `test-${crypto.randomUUID()}`;

  const app = createApp({
    env,
    logger,
    rateLimitStores: redisRateLimitStores(redis, prefix),
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
      // Object storage is faked in integration tests; the S3 adapter gets its own MinIO test in phase 2.
      storage: () => Promise.resolve(true),
    },
    isShuttingDown: () => false,
  });

  return {
    app,
    databaseUrl,
    async close() {
      await Promise.all([database.close(), redis.close()]);
    },
  };
}
