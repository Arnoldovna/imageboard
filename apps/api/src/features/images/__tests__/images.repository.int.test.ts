import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../../../test/fakes.js';
import { createTestDatabase, currentDatabaseUrl, type TestDatabase } from '../../../../test/test-db.js';
import { createDatabase, type Database, type DatabaseHandle } from '../../../db/client.js';
import * as schema from '../../../db/schema/index.js';
import { comments, images } from '../../../db/schema/index.js';
import { createImagesRepository, type ImagesRepository, type NewImage } from '../images.repository.js';

const RECORD_KEYS = [
  'authorName',
  'createdAt',
  'description',
  'height',
  'id',
  'mimeType',
  'objectKey',
  'ownerId',
  'title',
  'width',
];

function newImage(overrides: Partial<NewImage> = {}): NewImage {
  return {
    objectKey: `images/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1067,
    sizeBytes: 250_000,
    authorName: 'Henrik',
    title: 'The ridge, twice',
    description: 'No wind at all for about ten minutes.',
    ownerId: randomUUID(),
    ...overrides,
  };
}

/** Inserts with a fixed `created_at` (the repository leaves it to the database default). */
async function insertAt(db: Database, createdAt: string, overrides: Partial<NewImage> = {}): Promise<number> {
  const [row] = await db
    .insert(images)
    .values({ ...newImage(overrides), createdAt: new Date(createdAt) })
    .returning({ id: images.id });
  return row!.id;
}

describe('images repository: single rows (the file database)', () => {
  let handle: DatabaseHandle;
  let repository: ImagesRepository;

  beforeAll(() => {
    handle = createDatabase(currentDatabaseUrl(), silentLogger());
    repository = createImagesRepository(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('B-28: insert returns exactly the record columns, with a millisecond timestamp', async () => {
    const input = newImage();
    const record = await repository.insert(input);

    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
    expect(record).toMatchObject({
      objectKey: input.objectKey,
      mimeType: 'image/jpeg',
      width: 1600,
      height: 1067,
      authorName: 'Henrik',
      title: 'The ridge, twice',
      description: 'No wind at all for about ten minutes.',
      ownerId: input.ownerId,
    });
    expect(record.id).toBeGreaterThan(0);
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record).not.toHaveProperty('sizeBytes');
  });

  it('findById returns the record with explicit columns; exists follows the row', async () => {
    const { id } = await repository.insert(newImage());

    const found = await repository.findById(id);
    expect(Object.keys(found ?? {}).sort()).toEqual(RECORD_KEYS);
    await expect(repository.exists(id)).resolves.toBe(true);
    await expect(repository.findById(2_147_483_647)).resolves.toBeUndefined();
    await expect(repository.exists(2_147_483_647)).resolves.toBe(false);
  });

  it('F-35: deleteOwned with another owner deletes nothing', async () => {
    const { id } = await repository.insert(newImage());

    await expect(repository.deleteOwned(id, randomUUID())).resolves.toBeUndefined();
    await expect(repository.exists(id)).resolves.toBe(true);
  });

  it('F-D2 / B-22: deleteOwned removes the row and its comments in one statement and returns the object key', async () => {
    const input = newImage();
    const { id } = await repository.insert(input);
    const other = await repository.insert(newImage());
    await handle.db.insert(comments).values([
      { imageId: id, authorName: 'Marit', body: 'Where is this?', ownerId: randomUUID() },
      { imageId: id, authorName: 'Henrik', body: 'Two hours by train.', ownerId: input.ownerId },
      { imageId: other.id, authorName: 'Bea', body: 'Lovely.', ownerId: randomUUID() },
    ]);

    await expect(repository.deleteOwned(id, input.ownerId)).resolves.toBe(input.objectKey);

    await expect(repository.exists(id)).resolves.toBe(false);
    expect(await handle.db.select({ id: comments.id }).from(comments).where(eq(comments.imageId, id))).toEqual([]);
    // Other images keep their comments.
    expect(
      await handle.db.select({ id: comments.id }).from(comments).where(eq(comments.imageId, other.id)),
    ).toHaveLength(1);
    // A second delete finds nothing.
    await expect(repository.deleteOwned(id, input.ownerId)).resolves.toBeUndefined();
  });

  it('ADR 0019: deleteById removes regardless of owner, with its comments', async () => {
    const input = newImage();
    const { id } = await repository.insert(input);
    await handle.db.insert(comments).values({ imageId: id, authorName: 'Kofi', body: 'Nice.', ownerId: randomUUID() });

    await expect(repository.deleteById(id)).resolves.toBe(input.objectKey);
    await expect(repository.exists(id)).resolves.toBe(false);
    expect(await handle.db.select({ id: comments.id }).from(comments).where(eq(comments.imageId, id))).toEqual([]);
    await expect(repository.deleteById(id)).resolves.toBeUndefined();
  });
});

describe('images repository: keyset list (a pristine database)', () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let repository: ImagesRepository;

  beforeAll(async () => {
    database = await createTestDatabase();
    handle = createDatabase(database.url, silentLogger());
    repository = createImagesRepository(handle.db);
  });

  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  it('B-46: an empty table is an empty list', async () => {
    await expect(repository.list({ limit: 12 })).resolves.toEqual([]);
  });

  it('F-01: orders by created_at DESC, id DESC (ids break ties) and fetches limit + 1 rows', async () => {
    const old = await insertAt(handle.db, '2026-09-21T06:42:00.000Z');
    const tieA = await insertAt(handle.db, '2026-10-06T15:31:00.000Z');
    const tieB = await insertAt(handle.db, '2026-10-06T15:31:00.000Z');
    // Inserted last but older: order follows created_at, not id (seeds insert historic dates, ADR 0007).
    const historic = await insertAt(handle.db, '2026-09-01T00:00:00.000Z');
    const newest = await insertAt(handle.db, '2026-11-12T19:23:00.000Z');

    const all = await repository.list({ limit: 10 });
    expect(all.map((row) => row.id)).toEqual([newest, tieB, tieA, old, historic]);

    expect(await repository.list({ limit: 2 })).toHaveLength(3);
  });

  it('F-04 / ADR 0007: after a position returns strictly older rows, exact to the millisecond', async () => {
    const all = await repository.list({ limit: 10 });
    const [, second, third] = all;

    const page = await repository.list({ limit: 10, after: { createdAt: second!.createdAt, id: second!.id } });
    expect(page.map((row) => row.id)).toEqual(all.slice(2).map((row) => row.id));
    expect(page[0]?.id).toBe(third?.id);
  });

  it('ADR 0007: a millisecond-precise cursor neither skips nor repeats rows one millisecond apart', async () => {
    const earlier = await insertAt(handle.db, '2026-08-01T10:00:00.122Z');
    const later = await insertAt(handle.db, '2026-08-01T10:00:00.123Z');
    const all = await repository.list({ limit: 50 });
    const laterRow = all.find((row) => row.id === later);

    expect(laterRow?.createdAt.toISOString()).toBe('2026-08-01T10:00:00.123Z');
    const page = await repository.list({ limit: 1, after: { createdAt: laterRow!.createdAt, id: later } });
    expect(page[0]?.id).toBe(earlier);
  });

  it('B-40: the list query is served by images_created_at_id_idx without a Sort node', async () => {
    const captured: { query: string; params: unknown[] }[] = [];
    const pool = new pg.Pool({ connectionString: database.url, max: 1 });
    try {
      const logging = drizzle({
        client: pool,
        schema,
        casing: 'snake_case',
        logger: { logQuery: (query, params) => captured.push({ query, params }) },
      });
      const first = (await createImagesRepository(logging).list({ limit: 2 }))[0]!;
      await createImagesRepository(logging).list({ limit: 2, after: { createdAt: first.createdAt, id: first.id } });

      for (const { query, params } of captured) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // On a tiny table the planner prefers Seq Scan + Sort; forbid that so the index use itself is asserted.
          await client.query('SET LOCAL enable_seqscan = off');
          await client.query('SET LOCAL enable_bitmapscan = off');
          const result = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${query}`, params);
          const plan = JSON.stringify(result.rows[0]?.['QUERY PLAN']);
          expect(plan).toContain('"Index Name":"images_created_at_id_idx"');
          expect(plan).not.toContain('"Node Type":"Sort"');
          expect(plan).not.toContain('"Node Type":"Incremental Sort"');
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
      expect(captured).toHaveLength(2);
      expect(captured[1]?.query).toContain('::timestamptz');
    } finally {
      await pool.end();
    }
  });

  it('F-04: rows inserted or deleted between two pages are never duplicated or skipped', async () => {
    const firstPage = await repository.list({ limit: 3 });
    const shown = firstPage.slice(0, 3);
    const last = shown.at(-1)!;

    // A newer upload and a deletion of an already shown row happen between the two requests.
    await insertAt(handle.db, '2026-11-15T12:00:00.000Z');
    await handle.db.delete(images).where(eq(images.id, shown[0]!.id));

    const before = (
      await handle.db.execute<{ id: number }>(sql`select id from images order by created_at desc, id desc`)
    ).rows;
    const expected = before.map((row) => row.id).slice(before.findIndex((row) => row.id === last.id) + 1);

    const secondPage = await repository.list({ limit: 50, after: { createdAt: last.createdAt, id: last.id } });
    expect(secondPage.map((row) => row.id)).toEqual(expected);
    const shownIds = new Set(shown.map((row) => row.id));
    expect(secondPage.filter((row) => shownIds.has(row.id))).toEqual([]);
  });
});
