import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Database } from '../../../db/client.js';
import { comments, images, type NewCommentRow, type NewImageRow } from '../../../db/schema/index.js';
import type { CommentRecord, CommentsRepository, ListCommentsParams, NewComment } from '../comments.repository.js';

/*
 * Fakes for the service unit tests and row builders for the integration tests of the comments feature. Names, bodies
 * and titles read like real content (maw: no lorem, no "Jane Doe").
 */

// ---------------------------------------------------------------- in-memory repository

export interface FakeCommentsRepositoryOptions {
  /** Ids of existing images: inserting a comment for any other id behaves like FK violation 23503. */
  imageIds?: Iterable<number>;
  /** `created_at` of inserted rows. Default: one second apart from a fixed start, so the order is predictable. */
  now?: () => Date;
}

export interface FakeCommentsRepository extends CommentsRepository {
  /** Stored rows, in insertion order. */
  rows(): CommentRecord[];
  /** Adds a row as it is, like a direct insert with explicit values (ties on `createdAt`, historic dates). */
  seed(row: CommentRecord): void;
  hasImage(id: number): boolean;
  /** Deletes an image and, like `ON DELETE CASCADE`, its comments. */
  removeImage(id: number): void;
}

/** `(createdAt, id) < (after.createdAt, after.id)`, the SQL row comparison of the keyset query (ADR 0007). */
function isOlder(row: CommentRecord, after: NonNullable<ListCommentsParams['after']>): boolean {
  const delta = row.createdAt.getTime() - after.createdAt.getTime();
  return delta < 0 || (delta === 0 && row.id < after.id);
}

/** `ORDER BY created_at DESC, id DESC`. */
function newestFirst(a: CommentRecord, b: CommentRecord): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
}

export function createFakeCommentsRepository(options: FakeCommentsRepositoryOptions = {}): FakeCommentsRepository {
  const imageIds = new Set(options.imageIds ?? []);
  const stored = new Map<number, CommentRecord>();
  let nextId = 1;
  let tick = 0;
  const now =
    options.now ??
    (() => {
      tick += 1;
      return new Date(Date.UTC(2026, 10, 1, 12, 0, tick));
    });

  return {
    listForImage(imageId, { limit, after }) {
      const rows = [...stored.values()]
        .filter((row) => row.imageId === imageId && (after === undefined || isOlder(row, after)))
        .sort(newestFirst)
        .slice(0, limit + 1);
      return Promise.resolve(rows.map((row) => ({ ...row })));
    },
    insert(comment: NewComment) {
      if (!imageIds.has(comment.imageId)) return Promise.resolve(undefined);
      const row: CommentRecord = { ...comment, id: nextId, createdAt: now() };
      nextId += 1;
      stored.set(row.id, row);
      return Promise.resolve({ ...row });
    },
    exists(id) {
      return Promise.resolve(stored.has(id));
    },
    deleteOwned(id, ownerId) {
      const row = stored.get(id);
      if (row?.ownerId !== ownerId) return Promise.resolve(false);
      stored.delete(id);
      return Promise.resolve(true);
    },
    rows: () => [...stored.values()].map((row) => ({ ...row })),
    seed(row) {
      stored.set(row.id, { ...row });
      nextId = Math.max(nextId, row.id + 1);
    },
    hasImage: (id) => imageIds.has(id),
    removeImage(id) {
      imageIds.delete(id);
      for (const row of stored.values()) if (row.imageId === id) stored.delete(row.id);
    },
  };
}

// ---------------------------------------------------------------- rows for integration tests

/** A valid `images` row with a unique, well-formed object key. */
export function imageRow(overrides: Partial<NewImageRow> = {}): NewImageRow {
  return {
    objectKey: `images/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    width: 1600,
    height: 1067,
    sizeBytes: 245_812,
    authorName: 'Sanne',
    title: 'Fans all the way down',
    description: 'A repeat pattern, about six hours of compass work.',
    ownerId: randomUUID(),
    ...overrides,
  };
}

/** Inserts an image directly (the images module is not under test here) and returns its id. */
export async function insertImage(db: Database, overrides: Partial<NewImageRow> = {}): Promise<number> {
  const [row] = await db.insert(images).values(imageRow(overrides)).returning({ id: images.id });
  if (!row) throw new Error('image insert returned no row');
  return row.id;
}

export async function deleteImage(db: Database, id: number): Promise<void> {
  await db.delete(images).where(eq(images.id, id));
}

export type CommentSeed = Pick<NewCommentRow, 'imageId'> & Partial<NewCommentRow>;

/** Inserts comments directly with explicit values (fixed `createdAt` for exact order and tie tests); ids in order. */
export async function insertComments(db: Database, rows: readonly CommentSeed[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(comments)
    .values(
      rows.map((row) => ({
        authorName: 'Marit',
        body: 'That sky is doing a lot of work.',
        ownerId: randomUUID(),
        ...row,
      })),
    )
    .returning({ id: comments.id });
  return inserted.map((row) => row.id);
}

/** `count` comments one minute apart, oldest first, starting at `start`. Returns their ids, oldest first. */
export function insertTimeline(db: Database, imageId: number, count: number, start = Date.UTC(2026, 9, 6, 15, 52)) {
  return insertComments(
    db,
    Array.from({ length: count }, (_unused, index) => ({
      imageId,
      body: `Comment number ${String(index + 1)}`,
      createdAt: new Date(start + index * 60_000),
    })),
  );
}
