import { LIMITS } from '@app/shared';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { images } from './images.js';
import { multiLine, singleLine } from './text-checks.js';

export const comments = pgTable(
  'comments',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // Renames the legacy, misnamed `user_id` (B-38). Deleting an image deletes its comments in the same statement
    // (B-39, F-D2).
    imageId: integer()
      .notNull()
      .references(() => images.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    authorName: text().notNull(),
    body: text().notNull(),
    /** Anonymous session identity (ADR 0002). Never mapped into a DTO. */
    ownerId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    // FK lookup + keyset order in one index (B-40, F-27, F-31). DESC NULLS FIRST matches a plain
    // ORDER BY created_at DESC, id DESC (see images.ts).
    index('comments_image_id_created_at_id_idx').on(
      t.imageId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check('comments_author_name_valid', singleLine(t.authorName, LIMITS.authorName.min, LIMITS.authorName.max)),
    check('comments_body_valid', multiLine(t.body, LIMITS.commentBody.min, LIMITS.commentBody.max)),
  ],
);

export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;
