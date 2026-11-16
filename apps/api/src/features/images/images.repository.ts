import { ImageMimeType } from '@app/shared';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { olderThan } from '../../db/keyset.js';
import { images } from '../../db/schema/index.js';
import type { KeysetPosition } from '../../shared/pagination/cursor.js';

/**
 * An image as the service sees it: exactly the columns a DTO or an ownership check needs (B-28, F-43). `ownerId` is
 * read only to compute `canDelete`; `objectKey` only to build the media URLs. Neither leaves the server.
 */
export interface ImageRecord {
  id: number;
  objectKey: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  authorName: string;
  title: string;
  description: string;
  ownerId: string;
  createdAt: Date;
}

export interface NewImage {
  objectKey: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  sizeBytes: number;
  authorName: string;
  title: string;
  description: string;
  ownerId: string;
}

export interface ListImagesParams {
  limit: number;
  /** The last item the client has seen; the page holds strictly older items (ADR 0007). */
  after?: KeysetPosition | undefined;
}

/** The service depends on this interface, so its unit tests run against an in-memory fake. */
export interface ImagesRepository {
  /** Newest first (`created_at DESC, id DESC`), `limit + 1` rows: the extra row only signals another page (B-46). */
  list(params: ListImagesParams): Promise<ImageRecord[]>;
  findById(id: number): Promise<ImageRecord | undefined>;
  exists(id: number): Promise<boolean>;
  insert(image: NewImage): Promise<ImageRecord>;
  /**
   * One statement: `DELETE … WHERE id AND owner_id RETURNING object_key`; comments go by `ON DELETE CASCADE` in the
   * same statement (F-D2, B-22). `undefined` when no row matched (unknown id or another owner).
   */
  deleteOwned(id: number, ownerId: string): Promise<string | undefined>;
  /** The same without the owner condition: the admin takedown only (ADR 0019). */
  deleteById(id: number): Promise<string | undefined>;
}

/** Explicit column list: never `SELECT *`, never `size_bytes` or anything a later migration adds (B-28). */
const recordColumns = {
  id: images.id,
  objectKey: images.objectKey,
  mimeType: images.mimeType,
  width: images.width,
  height: images.height,
  authorName: images.authorName,
  title: images.title,
  description: images.description,
  ownerId: images.ownerId,
  createdAt: images.createdAt,
};

type RecordRow = Omit<ImageRecord, 'mimeType'> & { mimeType: string };

/** `mime_type` is a CHECK-constrained text column; anything else in it is a server bug, not a client error. */
function toRecord(row: RecordRow): ImageRecord {
  return { ...row, mimeType: ImageMimeType.parse(row.mimeType) };
}

export function createImagesRepository(db: Database): ImagesRepository {
  return {
    async list({ limit, after }) {
      // Served by images_created_at_id_idx without a Sort node.
      const rows = await db
        .select(recordColumns)
        .from(images)
        .where(olderThan(images.createdAt, images.id, after))
        .orderBy(desc(images.createdAt), desc(images.id))
        .limit(limit + 1);
      return rows.map(toRecord);
    },

    async findById(id) {
      const [row] = await db.select(recordColumns).from(images).where(eq(images.id, id)).limit(1);
      return row ? toRecord(row) : undefined;
    },

    async exists(id) {
      const [row] = await db.select({ id: images.id }).from(images).where(eq(images.id, id)).limit(1);
      return row !== undefined;
    },

    async insert(image) {
      const [row] = await db.insert(images).values(image).returning(recordColumns);
      if (!row) throw new Error('INSERT … RETURNING returned no row');
      return toRecord(row);
    },

    async deleteOwned(id, ownerId) {
      const [row] = await db
        .delete(images)
        .where(and(eq(images.id, id), eq(images.ownerId, ownerId)))
        .returning({ objectKey: images.objectKey });
      return row?.objectKey;
    },

    async deleteById(id) {
      const [row] = await db.delete(images).where(eq(images.id, id)).returning({ objectKey: images.objectKey });
      return row?.objectKey;
    },
  };
}
