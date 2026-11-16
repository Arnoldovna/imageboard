import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../../../test/fakes.js';
import { currentDatabaseUrl, withDatabase } from '../../../../test/test-db.js';
import { createDatabase, type DatabaseHandle } from '../../../db/client.js';
import { decodeCursor, encodeCursor, type KeysetPosition } from '../../../shared/pagination/cursor.js';
import {
  type CommentRecord,
  type CommentsRepository,
  createCommentsRepository,
  listForImageQuery,
} from '../comments.repository.js';
import { deleteImage, insertComments, insertImage, insertTimeline } from './fakes.js';

/*
 * The comments repository against real Postgres 18 (this file's own clone of the migrated template, ADR 0015). Each
 * test inserts into its own image, so the tests share the database without seeing each other's rows.
 */

let handle: DatabaseHandle;
let repository: CommentsRepository;

beforeAll(() => {
  handle = createDatabase(currentDatabaseUrl(), silentLogger());
  repository = createCommentsRepository(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const positionOf = (row: CommentRecord): KeysetPosition => ({ createdAt: row.createdAt, id: row.id });

/** Follows `limit + 1` pages the way the service does, returning every id in the order received. */
async function readAll(imageId: number, limit: number): Promise<number[]> {
  const ids: number[] = [];
  let after: KeysetPosition | undefined;
  for (;;) {
    const rows = await repository.listForImage(imageId, { limit, after });
    const page = rows.slice(0, limit);
    ids.push(...page.map((row) => row.id));
    const last = page.at(-1);
    if (rows.length <= limit || last === undefined) return ids;
    after = positionOf(last);
  }
}

describe('comments repository: insert', () => {
  it('stores the comment and returns the record with a millisecond timestamp', async () => {
    const imageId = await insertImage(handle.db);
    const ownerId = randomUUID();

    const row = await repository.insert({ imageId, authorName: 'Kofi', body: 'Where does it go?', ownerId });

    expect(row).toEqual({
      id: expect.any(Number) as number,
      imageId,
      authorName: 'Kofi',
      body: 'Where does it go?',
      ownerId,
      createdAt: expect.any(Date) as Date,
    });
    // timestamptz(3): the value round-trips through a cursor exactly (ADR 0007).
    expect(row?.createdAt.toISOString()).toMatch(/\.\d{3}Z$/);
  });

  it('B-26: an unknown image gives undefined (FK 23503), not an error', async () => {
    await expect(
      repository.insert({ imageId: 2_147_483_647, authorName: 'Kofi', body: 'Hello?', ownerId: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it('B-26: an image deleted before the insert gives undefined as well', async () => {
    const imageId = await insertImage(handle.db);
    await deleteImage(handle.db, imageId);

    await expect(
      repository.insert({ imageId, authorName: 'Kofi', body: 'Too late.', ownerId: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it('any other database error still propagates (a CHECK violation is not mistaken for a missing image)', async () => {
    const imageId = await insertImage(handle.db);

    await expect(
      repository.insert({ imageId, authorName: ' padded ', body: 'Fine.', ownerId: randomUUID() }),
    ).rejects.toThrow();
  });
});

describe('comments repository: listForImage', () => {
  it('F-27 / B-41: newest first; equal timestamps are ordered by id, highest first', async () => {
    const imageId = await insertImage(handle.db);
    const at = new Date('2026-10-06T15:52:00.000Z');
    const later = new Date('2026-10-06T16:00:00.000Z');
    const [oldest, tieA, tieB, newest] = await insertComments(handle.db, [
      { imageId, createdAt: at, body: 'oldest' },
      { imageId, createdAt: later, body: 'tie a' },
      { imageId, createdAt: later, body: 'tie b' },
      { imageId, createdAt: new Date('2026-10-07T09:00:00.000Z'), body: 'newest' },
    ]);

    const rows = await repository.listForImage(imageId, { limit: 20 });

    expect(rows.map((row) => row.id)).toEqual([newest, tieB, tieA, oldest]);
    // The same order every time the list is read again (B-41: stable when the dialog is reopened).
    expect((await repository.listForImage(imageId, { limit: 20 })).map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it('F-31 / B-45: fetches limit + 1 rows, and keyset pages cover every comment exactly once', async () => {
    const imageId = await insertImage(handle.db);
    const ids = await insertTimeline(handle.db, imageId, 25);

    expect(await repository.listForImage(imageId, { limit: 20 })).toHaveLength(21);
    expect(await readAll(imageId, 20)).toEqual([...ids].reverse());
    expect(await readAll(imageId, 7)).toEqual([...ids].reverse());
  });

  it('F-31: the keyset continues correctly across rows that share a timestamp', async () => {
    const imageId = await insertImage(handle.db);
    const at = new Date('2026-10-06T15:52:00.123Z');
    const ids = await insertComments(
      handle.db,
      Array.from({ length: 5 }, () => ({ imageId, createdAt: at })),
    );

    expect(await readAll(imageId, 2)).toEqual([...ids].reverse());
  });

  it('F-04: a comment written between two page requests is neither repeated nor skipped', async () => {
    const imageId = await insertImage(handle.db);
    const ids = await insertTimeline(handle.db, imageId, 5);
    const first = (await repository.listForImage(imageId, { limit: 2 })).slice(0, 2);

    await insertComments(handle.db, [{ imageId, body: 'Brand new.' }]);
    const rest = await repository.listForImage(imageId, { limit: 10, after: positionOf(first.at(-1)!) });

    expect([...first, ...rest].map((row) => row.id)).toEqual([...ids].reverse());
  });

  it('returns only the comments of the requested image, and none for an unknown one', async () => {
    const imageId = await insertImage(handle.db);
    const otherId = await insertImage(handle.db);
    await insertTimeline(handle.db, otherId, 3);
    const mine = await insertTimeline(handle.db, imageId, 2);

    expect((await repository.listForImage(imageId, { limit: 20 })).map((row) => row.id)).toEqual([...mine].reverse());
    expect(await repository.listForImage(2_147_483_647, { limit: 20 })).toEqual([]);
  });

  it('a cursor encoded by the API decodes to the exact stored position (millisecond precision)', async () => {
    const imageId = await insertImage(handle.db);
    const ids = await insertTimeline(handle.db, imageId, 3, Date.UTC(2026, 9, 6, 15, 52, 0, 7));
    const [newest] = await repository.listForImage(imageId, { limit: 1 });

    // Through the opaque string and back, as a client would hand it in.
    const after = decodeCursor(encodeCursor(positionOf(newest!)));
    const older = await repository.listForImage(imageId, { limit: 20, after });

    expect(older.map((row) => row.id)).toEqual([ids[1], ids[0]]);
  });
});

describe('comments repository: exists and deleteOwned', () => {
  it('F-32: deletes only with the matching owner, in one statement', async () => {
    const imageId = await insertImage(handle.db);
    const ownerId = randomUUID();
    const [id] = await insertComments(handle.db, [{ imageId, ownerId }]);

    expect(await repository.deleteOwned(id!, randomUUID())).toBe(false);
    expect(await repository.exists(id!)).toBe(true);

    expect(await repository.deleteOwned(id!, ownerId)).toBe(true);
    expect(await repository.exists(id!)).toBe(false);
    expect(await repository.deleteOwned(id!, ownerId)).toBe(false);
  });

  it('F-D2: deleting the image removes its comments (ON DELETE CASCADE)', async () => {
    const imageId = await insertImage(handle.db);
    const ids = await insertTimeline(handle.db, imageId, 3);

    await deleteImage(handle.db, imageId);

    for (const id of ids) expect(await repository.exists(id)).toBe(false);
  });
});

// ---------------------------------------------------------------- B-40: the list query is served by the index

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/**
 * `EXPLAIN (FORMAT JSON)` of exactly the repository's SQL. Seq scans and bitmap scans are switched off for this
 * transaction only (`SET LOCAL`): on a table this small the planner would otherwise rightly prefer Seq Scan + Sort,
 * and the assertion would depend on statistics instead of on whether the index *can* serve filter and order.
 */
async function planOf(imageId: number, after?: KeysetPosition): Promise<PlanNode[]> {
  const query = listForImageQuery(handle.db, imageId, { limit: 20, after }).toSQL();
  return withDatabase(currentDatabaseUrl(), async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      const result = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (FORMAT JSON) ${query.sql}`,
        query.params,
      );
      const plan = result.rows[0]?.['QUERY PLAN'][0].Plan;
      if (plan === undefined) throw new Error('EXPLAIN returned no plan');
      return flatten(plan);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

describe('B-40: the comment list uses comments_image_id_created_at_id_idx', () => {
  let imageId: number;

  beforeAll(async () => {
    imageId = await insertImage(handle.db);
    await insertTimeline(handle.db, imageId, 30);
    await withDatabase(currentDatabaseUrl(), (client) => client.query('ANALYZE comments'));
  });

  it('B-40: the first page is an index scan on the composite index without a Sort node', async () => {
    const nodes = await planOf(imageId);

    expect(nodes).toContainEqual(
      expect.objectContaining({ 'Node Type': 'Index Scan', 'Index Name': 'comments_image_id_created_at_id_idx' }),
    );
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Incremental Sort');
  });

  it('B-40: a cursor page is an index scan on the composite index without a Sort node', async () => {
    const nodes = await planOf(imageId, { createdAt: new Date('2026-10-06T16:10:00.000Z'), id: 2_000_000 });

    expect(nodes).toContainEqual(
      expect.objectContaining({ 'Node Type': 'Index Scan', 'Index Name': 'comments_image_id_created_at_id_idx' }),
    );
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Incremental Sort');
  });
});
