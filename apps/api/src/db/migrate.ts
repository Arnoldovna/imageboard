import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { pino, type Logger } from 'pino';

import { createDatabase } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Used by the integration-test global setup and by the one-off `migrate` container in production. */
export async function runMigrations(databaseUrl: string, logger: Pick<Logger, 'error'>): Promise<void> {
  const handle = createDatabase(databaseUrl, logger);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url, pino());
}
