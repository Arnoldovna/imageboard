import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { olderThan } from '../../db/keyset.js';
import { comments } from '../../db/schema/index.js';
import { isForeignKeyViolation, pgConstraintName } from '../../shared/errors/db-errors.js';
import type { KeysetPosition } from '../../shared/pagination/cursor.js';

/** The columns the service needs: the DTO fields plus `ownerId` for `canDelete` (never mapped into a DTO, F-43). */
export interface CommentRecord {
  id: number;
  imageId: number;
  authorName: string;
  body: string;
  ownerId: string;
  createdAt: Date;
}

export interface NewComment {
  imageId: number;
  authorName: string;
  body: string;
  ownerId: string;
}

export interface ListCommentsParams {
  limit: number;
  /** The last comment the client has seen; omitted for the first page. */
  after?: KeysetPosition | undefined;
}

/** The service depends on this interface, so unit tests pass an in-memory fake (`__tests__/fakes.ts`). */
export interface CommentsRepository {
  /** Newest first (`created_at DESC, id DESC`), at most `limit + 1` rows: the extra row signals another page. */
  listForImage(imageId: number, params: ListCommentsParams): Promise<CommentRecord[]>;
  /** `undefined` when the image does not exist (or was deleted meanwhile): FK violation `23503`. */
  insert(comment: NewComment): Promise<CommentRecord | undefined>;
  exists(id: number): Promise<boolean>;
  /** One atomic statement; true when a row with that id **and** owner was deleted. */
  deleteOwned(id: number, ownerId: string): Promise<boolean>;
}

/** Explicit column list (no `SELECT *`, B-28). */
const RECORD_COLUMNS = {
  id: comments.id,
  imageId: comments.imageId,
  authorName: comments.authorName,
  body: comments.body,
  ownerId: comments.ownerId,
  createdAt: comments.createdAt,
};

/** The only foreign key on `comments` (drizzle-kit's name, `drizzle/0000_init.sql`). */
const IMAGE_FOREIGN_KEY = 'comments_image_id_images_id_fk';

/**
 * The keyset page query (ADR 0007, DATA-MODEL §4). `image_id = $1` plus the row comparison and the ORDER BY match
 * `comments_image_id_created_at_id_idx` column for column, so Postgres reads the page straight from the index without
 * a Sort node (B-40). Exported so the repository test can `EXPLAIN` exactly this SQL.
 */
export function listForImageQuery(db: Database, imageId: number, { limit, after }: ListCommentsParams) {
  return db
    .select(RECORD_COLUMNS)
    .from(comments)
    .where(and(eq(comments.imageId, imageId), olderThan(comments.createdAt, comments.id, after)))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(limit + 1);
}

export function createCommentsRepository(db: Database): CommentsRepository {
  return {
    listForImage(imageId, params) {
      return listForImageQuery(db, imageId, params);
    },

    async insert(comment) {
      try {
        const [row] = await db.insert(comments).values(comment).returning(RECORD_COLUMNS);
        if (!row) throw new Error('comment insert returned no row');
        return row;
      } catch (error) {
        // The image is unknown or was deleted between the request and the insert: a 404 for the service, not a 500
        // (B-26, ADR 0009). Any other error (including a CHECK violation, mapped centrally) propagates.
        if (isForeignKeyViolation(error) && pgConstraintName(error) === IMAGE_FOREIGN_KEY) return undefined;
        throw error;
      }
    },

    async exists(id) {
      const rows = await db.select({ id: comments.id }).from(comments).where(eq(comments.id, id)).limit(1);
      return rows.length > 0;
    },

    async deleteOwned(id, ownerId) {
      const rows = await db
        .delete(comments)
        .where(and(eq(comments.id, id), eq(comments.ownerId, ownerId)))
        .returning({ id: comments.id });
      return rows.length > 0;
    },
  };
}
