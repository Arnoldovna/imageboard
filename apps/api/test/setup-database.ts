import { afterAll, beforeAll } from 'vitest';

import { createTestDatabase, setCurrentDatabaseUrl, type TestDatabase } from './test-db.js';

/*
 * Vitest `setupFiles` entry of the integration project: every test file gets its own clone of
 * `imageboard_template` (conventions §7, ADR 0015, ADR 0021 §3). Files run in parallel and never see each other's
 * rows or identity sequences, so there is no TRUNCATE anywhere. These hooks run before the file's own beforeAll and
 * (hooks are stacked) after its own afterAll.
 */
let database: TestDatabase | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  setCurrentDatabaseUrl(database.url);
});

afterAll(async () => {
  setCurrentDatabaseUrl(undefined);
  await database?.drop();
});
