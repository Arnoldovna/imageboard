import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

/** Migrated once per run by test/global-setup.ts (conventions §7: `<slug>_template`). */
export const TEMPLATE_DATABASE = 'imageboard_template';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Opens one client, runs `fn`, always closes it. */
export async function withDatabase<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The same server and credentials as `serverUrl`, but database `name`. */
export function databaseUrl(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** `t_<16 random hex>`: random, so files running in parallel never collide; only [a-z0-9_], so quoting is safe. */
async function createDatabase(fromTemplate: boolean): Promise<TestDatabase> {
  const name = `t_${randomBytes(8).toString('hex')}`;
  const template = fromTemplate ? ` TEMPLATE "${inject('templateName')}"` : '';
  await withDatabase(inject('adminUrl'), (client) => client.query(`CREATE DATABASE "${name}"${template}`));
  return {
    url: databaseUrl(inject('adminUrl'), name),
    drop: async () => {
      // FORCE terminates connections a test forgot to close; the database never outlives its test file.
      await withDatabase(inject('adminUrl'), (client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}

let currentUrl: string | undefined;

/** Called only by test/setup-database.ts. */
export function setCurrentDatabaseUrl(url: string | undefined): void {
  currentUrl = url;
}

/** The test file's own database, cloned by test/setup-database.ts. Throws outside a test file. */
export function currentDatabaseUrl(): string {
  if (currentUrl === undefined) {
    throw new Error('No test database: currentDatabaseUrl() only works inside an integration test file');
  }
  return currentUrl;
}

/** An extra migrated clone for a block that needs pristine tables (exact pages, known ids). Call `drop()` after. */
export function createTestDatabase(): Promise<TestDatabase> {
  return createDatabase(true);
}

/** An empty, unmigrated database (migrations.int.test.ts). Call `drop()` after. */
export function createEmptyDatabase(): Promise<TestDatabase> {
  return createDatabase(false);
}
