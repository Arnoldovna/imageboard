import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../src/db/migrate.js';
import { POSTGRES_IMAGE, REDIS_IMAGE } from './images.js';
import { silentLogger } from './fakes.js';
import { databaseUrl, TEMPLATE_DATABASE, withDatabase } from './test-db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of the maintenance database `postgres`, used to create and drop test databases. */
    adminUrl: string;
    /** `imageboard_template`: migrated once per run, cloned per test file. */
    templateName: string;
    redisUrl: string;
  }
}

/**
 * One Postgres 18 and one Redis 8 container per run (digests in test/images.ts, the same as compose). Migrates the
 * template database once and closes every connection to it, because `CREATE DATABASE … TEMPLATE` fails while anyone
 * is connected to the template (conventions §7, ADR 0015).
 */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const adminUrl = databaseUrl(postgres.getConnectionUri(), 'postgres');
  await withDatabase(adminUrl, (client) => client.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`));

  // runMigrations opens and ends its own pool, so no connection to the template survives this call.
  await runMigrations(databaseUrl(adminUrl, TEMPLATE_DATABASE), silentLogger());

  project.provide('adminUrl', adminUrl);
  project.provide('templateName', TEMPLATE_DATABASE);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
