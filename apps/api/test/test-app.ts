import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { cookiesAreSecure, type EnvKey, loadEnv } from '../src/config/env.js';
import { createDatabase, type Database } from '../src/db/client.js';
import type { ImageUploadPort } from '../src/shared/ports/image-upload.js';
import { connectRedis } from '../src/shared/redis/redis.js';
import { redisRateLimitStores } from '../src/shared/security/security.js';
import { createSessionMiddleware, sessionLifetimes } from '../src/shared/security/session.js';
import type { ObjectStorage } from '../src/shared/storage/object-storage.js';
import { createFakeStorage, silentLogger } from './fakes.js';
import { currentDatabaseUrl } from './test-db.js';

export interface TestAppOptions {
  /** Merged over test defaults. Defaults set every RATE_LIMIT_* to '100000' so no test hits a limiter by accident;
   *  only rate-limits.int.test.ts passes small values. */
  env?: Partial<Record<EnvKey, string>>;
  storage?: ObjectStorage; // default createFakeStorage()
  upload?: ImageUploadPort; // default: the real upload module on `storage`
  databaseUrl?: string; // default: currentDatabaseUrl(), the test file's clone made by test/setup-database.ts
}

export interface TestApp {
  app: Express;
  db: Database;
  storage: ObjectStorage;
  databaseUrl: string;
  close(): Promise<void>; // closes pool + Redis; never drops a database (setup file or caller does)
}

export const RAISED_LIMITS = {
  RATE_LIMIT_GLOBAL: '100000',
  RATE_LIMIT_IDENTITIES: '100000',
  RATE_LIMIT_UPLOADS: '100000',
  RATE_LIMIT_UPLOADS_GLOBAL_DAY: '100000',
  RATE_LIMIT_COMMENTS: '100000',
  RATE_LIMIT_DELETES: '100000',
  RATE_LIMIT_MEDIA: '100000',
} satisfies Partial<Record<EnvKey, string>>;

/**
 * The real app (ADR 0017) on the file's Testcontainers database and the run's Redis, fake object storage, silent
 * logger. It wires `createApp` like `container.ts` does, through the same factories (`createDatabase`,
 * `connectRedis`, `createSessionMiddleware`), but with a fresh Redis prefix `test-<uuid>` per app: sessions under
 * `test-<uuid>:sess:`, limiters under `test-<uuid>:rl:<name>:` (ADR 0021 §3).
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const databaseUrl = options.databaseUrl ?? currentDatabaseUrl();
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
  const logger = silentLogger();
  const database = createDatabase(env.DATABASE_URL, logger);
  const redis = await connectRedis(env.REDIS_URL, 'test', logger);
  const storage = options.storage ?? createFakeStorage();
  const prefix = `test-${randomUUID()}`;

  const app = createApp({
    env,
    logger,
    db: database.db,
    storage,
    session: createSessionMiddleware({
      redis,
      secret: env.SESSION_SECRET,
      secure: cookiesAreSecure(env),
      prefix,
      lifetimes: sessionLifetimes(env),
    }),
    rateLimitStores: redisRateLimitStores(redis, prefix),
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
      storage: () => storage.isReady(),
    },
    isShuttingDown: () => false,
    ...(options.upload ? { overrides: { uploadPort: options.upload } } : {}),
  });

  return {
    app,
    db: database.db,
    storage,
    databaseUrl,
    async close() {
      await Promise.all([database.close(), redis.close()]);
    },
  };
}
