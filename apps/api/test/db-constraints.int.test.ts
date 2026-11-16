import { randomUUID } from 'node:crypto';

import { TEXT_VECTORS, type TextField, type TextVector } from '@app/shared/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEXT_CHECKS } from '../src/shared/errors/db-errors.js';
import { currentDatabaseUrl } from './test-db.js';

/*
 * F-D3 / B-43: the DB CHECKs enforce the same rules as the shared Zod schemas. Direct inserts (no Zod, no API) of the
 * shared vectors must get exactly the verdict the vector file states, and every value Zod produces must be storable.
 * Runs in this file's own database (test/setup-database.ts).
 */

type Row = Readonly<Record<string, string | number>>;

let client: pg.Client;
let parentImageId: number;

function imageRow(overrides: Row = {}): Row {
  return {
    object_key: `images/${randomUUID()}.jpg`,
    mime_type: 'image/jpeg',
    width: 640,
    height: 480,
    size_bytes: 12_345,
    author_name: 'Kofi',
    title: 'Commute, the long way round',
    description: '',
    owner_id: randomUUID(),
    ...overrides,
  };
}

function commentRow(overrides: Row = {}): Row {
  return {
    image_id: parentImageId,
    author_name: 'Noor',
    body: 'Lovely textures.',
    owner_id: randomUUID(),
    ...overrides,
  };
}

/** Column names come from the fixed rows above (never from vectors), so building the column list is safe. */
async function insert(table: 'images' | 'comments', row: Row): Promise<number> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `$${String(index + 1)}`);
  const result = await client.query<{ id: number }>(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    Object.values(row),
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('insert returned no id');
  return id;
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
    throw error;
  }
}

/** Every column a text field is stored in. */
const COLUMNS: Record<TextField, readonly { table: 'images' | 'comments'; column: string }[]> = {
  authorName: [
    { table: 'images', column: 'author_name' },
    { table: 'comments', column: 'author_name' },
  ],
  title: [{ table: 'images', column: 'title' }],
  description: [{ table: 'images', column: 'description' }],
  body: [{ table: 'comments', column: 'body' }],
};

function insertText(table: 'images' | 'comments', column: string, value: string): Promise<number> {
  return table === 'images'
    ? insert('images', imageRow({ [column]: value }))
    : insert('comments', commentRow({ [column]: value }));
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: currentDatabaseUrl() });
  await client.connect();
  parentImageId = await insert('images', imageRow());
});

afterAll(async () => {
  await client.end();
});

describe.each(Object.keys(TEXT_VECTORS) as TextField[])('F-D3 / B-43: %s CHECK matches the shared vectors', (field) => {
  const cases = COLUMNS[field].flatMap(({ table, column }) =>
    TEXT_VECTORS[field].map((vector) => [`${table}.${column}: ${vector.name}`, table, column, vector] as const),
  );

  it.each(cases)('%s', async (_name, table, column, vector: TextVector) => {
    const code = await errorCodeOf(insertText(table, column, vector.input));

    if (vector.db === 'accept') expect(code).toBeUndefined();
    // 23514: check_violation. 22021: Postgres text cannot hold U+0000 at all.
    else if (vector.db === 'reject') expect(code).toBe('23514');
    else expect(code).toBe('22021');

    // Whatever Zod produces must satisfy the CHECK: Zod and SQL agree on every normalised value.
    if ('value' in vector.zod) expect(await errorCodeOf(insertText(table, column, vector.zod.value))).toBeUndefined();
  });
});

describe('F-D3: CHECKs on server-computed image columns', () => {
  const uuid = '3f6d2c1e-8a4b-4c1d-9e2f-0a1b2c3d4e5f';

  it.each([
    ['an absolute URL instead of a key (B-35)', { object_key: `https://bucket.s3.amazonaws.com/images/${uuid}.jpg` }],
    ['path traversal', { object_key: `images/../${uuid}.jpg` }],
    ['uppercase hex', { object_key: `images/${uuid.toUpperCase()}.jpg` }],
    ['a UUID that is not v4', { object_key: 'images/3f6d2c1e-8a4b-1c1d-9e2f-0a1b2c3d4e5f.jpg' }],
    ['a preview key', { object_key: `previews/${uuid}.webp`, mime_type: 'image/webp' }],
    ['an SVG key', { object_key: `images/${uuid}.svg` }],
    ['a MIME type outside the allow-list', { object_key: `images/${uuid}.gif`, mime_type: 'image/svg+xml' }],
    [
      'an extension that does not match the MIME type (B-05)',
      { object_key: `images/${uuid}.png`, mime_type: 'image/jpeg' },
    ],
    ['zero width', { width: 0 }],
    ['negative height', { height: -1 }],
    ['zero size', { size_bytes: 0 }],
  ])('rejects %s', async (_case, overrides: Row) => {
    expect(await errorCodeOf(insert('images', imageRow(overrides)))).toBe('23514');
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('accepts %s stored as .%s', async (mimeType, extension) => {
    expect(
      await errorCodeOf(
        insert('images', imageRow({ mime_type: mimeType, object_key: `images/${randomUUID()}.${extension}` })),
      ),
    ).toBeUndefined();
  });

  it('object keys are unique', async () => {
    const objectKey = `images/${randomUUID()}.jpg`;
    await insert('images', imageRow({ object_key: objectKey }));

    expect(await errorCodeOf(insert('images', imageRow({ object_key: objectKey })))).toBe('23505');
  });

  it('ids are always generated by the database', async () => {
    expect(await errorCodeOf(insert('images', imageRow({ id: 999 })))).toBe('428C9');
  });
});

describe('relations (F-D2, B-26, B-38, B-39)', () => {
  it('B-26: a comment on a missing image violates the foreign key (23503)', async () => {
    expect(await errorCodeOf(insert('comments', commentRow({ image_id: 2_147_483_647 })))).toBe('23503');
  });

  it('F-D2 / B-39: deleting an image deletes its comments in the same statement', async () => {
    const imageId = await insert('images', imageRow());
    await insert('comments', commentRow({ image_id: imageId }));
    await insert('comments', commentRow({ image_id: imageId }));

    await client.query('DELETE FROM images WHERE id = $1', [imageId]);
    const remaining = await client.query('SELECT 1 FROM comments WHERE image_id = $1', [imageId]);

    expect(remaining.rowCount).toBe(0);
  });
});

describe('schema shape (DATA-MODEL.md)', () => {
  it('B-42: timestamps are timestamptz with millisecond precision and default now()', async () => {
    const result = await client.query<{
      table_name: string;
      data_type: string;
      datetime_precision: number;
      column_default: string;
    }>(
      `SELECT table_name, data_type, datetime_precision, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'created_at' ORDER BY table_name`,
    );

    expect(result.rows).toEqual([
      { table_name: 'comments', data_type: 'timestamp with time zone', datetime_precision: 3, column_default: 'now()' },
      { table_name: 'images', data_type: 'timestamp with time zone', datetime_precision: 3, column_default: 'now()' },
    ]);
  });

  it('B-40: one composite index per keyset ordering', async () => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_created_at_id_idx' ORDER BY indexname",
    );

    expect(result.rows.map((row) => [row.indexname, row.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['comments_image_id_created_at_id_idx', '(image_id, created_at DESC, id DESC)'],
      ['images_created_at_id_idx', '(created_at DESC, id DESC)'],
    ]);
  });

  it('B-38: the comment foreign key column is image_id and cascades on delete only', async () => {
    const result = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'comments_image_id_images_id_fk'",
    );

    expect(result.rows[0]?.definition).toBe(
      'FOREIGN KEY (image_id) REFERENCES images(id) ON UPDATE RESTRICT ON DELETE CASCADE',
    );
  });

  it('ADR 0006: every text CHECK maps to a client field for the 400 fallback, and every mapping exists', async () => {
    const result = await client.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%_valid' ORDER BY conname",
    );

    expect(result.rows.map((row) => row.conname).sort()).toEqual([...TEXT_CHECKS.keys()].sort());
  });
});
