import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { pino } from 'pino';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../src/db/migrate.js';
import { POSTGRES_IMAGE, REDIS_IMAGE } from './images.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * One Postgres + one Redis per test run (images pinned in test/images.ts).
 * Phase 1b replaces this with the template-database harness (conventions §7, ADR 0015).
 */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const databaseUrl = postgres.getConnectionUri();
  await runMigrations(databaseUrl, pino({ level: 'silent' }));

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
