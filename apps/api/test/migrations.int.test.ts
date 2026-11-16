import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.js';
import { silentLogger } from './fakes.js';
import { createEmptyDatabase, type TestDatabase, withDatabase } from './test-db.js';

const countMigrations = (url: string) =>
  withDatabase(url, async (client) => {
    const result = await client.query<{ count: string }>('SELECT count(*) FROM drizzle.__drizzle_migrations');
    return Number(result.rows[0]?.count);
  });

describe('migrations (F-D1)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createEmptyDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('F-D1 / B-37: migrate an empty database twice without errors or changes', async () => {
    await runMigrations(database.url, silentLogger());
    const afterFirst = await countMigrations(database.url);
    await runMigrations(database.url, silentLogger());

    expect(afterFirst).toBeGreaterThan(0);
    expect(await countMigrations(database.url)).toBe(afterFirst);
  });

  it('F-D1: creates exactly the two tables of DATA-MODEL.md', async () => {
    const tables = await withDatabase(database.url, async (client) => {
      const result = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      return result.rows.map((row) => row.table_name);
    });

    expect(tables).toEqual(['comments', 'images']);
  });

  it('B-37: migrations never drop anything and the SQL is committed', async () => {
    const files = (await readdir(MIGRATIONS_FOLDER)).filter((file) => file.endsWith('.sql'));
    expect(files).toContain('0000_init.sql');
    for (const file of files) {
      expect(await readFile(join(MIGRATIONS_FOLDER, file), 'utf8')).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE)\b/i);
    }
  });
});
