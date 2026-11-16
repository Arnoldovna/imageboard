import { LIMITS } from '@app/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { multiLine, singleLine } from './text-checks.js';

export const IMAGE_MIME_TYPES_SQL = sql`('image/jpeg', 'image/png', 'image/webp', 'image/gif')`;

export const images = pgTable(
  'images',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    objectKey: text().notNull().unique('images_object_key_key'),
    mimeType: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    sizeBytes: integer().notNull(),
    authorName: text().notNull(),
    title: text().notNull(),
    description: text().notNull().default(''),
    /** Anonymous session identity (ADR 0002). Read for ownership checks only, never mapped into a DTO (B-28). */
    ownerId: uuid().notNull(),
    /** Millisecond precision so a keyset cursor round-trips exactly (ADR 0007). */
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    // Keyset pagination: ORDER BY created_at DESC, id DESC (F-01, F-04). NULLS FIRST is Postgres' default for DESC,
    // so the plain ORDER BY (Drizzle `desc()`) is served by this index without a Sort; drizzle-kit's default
    // NULLS LAST would need `DESC NULLS LAST` in every query. The columns are NOT NULL either way.
    index('images_created_at_id_idx').on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),

    check(
      'images_object_key_format',
      sql`${t.objectKey} ~ '^images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(jpg|png|webp|gif)$'`,
    ),
    check('images_mime_type_allowed', sql`${t.mimeType} IN ${IMAGE_MIME_TYPES_SQL}`),
    // Extension and MIME type must agree (B-05).
    check(
      'images_object_key_matches_mime',
      sql`substring(${t.objectKey} from '\\.([a-z]+)$') = CASE ${t.mimeType} WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' WHEN 'image/gif' THEN 'gif' END`,
    ),
    check('images_dimensions_positive', sql`${t.width} > 0 AND ${t.height} > 0`),
    check('images_size_positive', sql`${t.sizeBytes} > 0`),
    check('images_author_name_valid', singleLine(t.authorName, LIMITS.authorName.min, LIMITS.authorName.max)),
    check('images_title_valid', singleLine(t.title, LIMITS.title.min, LIMITS.title.max)),
    check('images_description_valid', multiLine(t.description, LIMITS.description.min, LIMITS.description.max)),
  ],
);

export type ImageRow = typeof images.$inferSelect;
export type NewImageRow = typeof images.$inferInsert;
