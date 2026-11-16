import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { and, count, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '../db/client.js';
import { comments, images } from '../db/schema/index.js';
import { previewKeyOf } from '../features/upload/index.js';
import type { ImageUploadPort, IncomingFile, StoredImage } from '../shared/ports/image-upload.js';
import { ObjectNotFoundError, type ObjectStorage } from '../shared/storage/object-storage.js';
import {
  joinSeed,
  readManifest,
  SEED_IMAGES,
  SEED_IMAGES_DIR,
  SEED_OWNER_ID,
  SEED_TOTALS,
  type SeedEntry,
  type SeedImage,
  SeedManifest,
} from './seed-content.js';

/*
 * `runSeed()` and `checkSeed()` (DATA-MODEL §6, ADR 0014). Neither has a guard: the `SEED_ALLOW` switch lives in the
 * entry point `seed-cli.ts`, because tests call these functions directly with their own database and fake storage.
 * The seed only inserts, restores missing seed objects and skips; it never deletes or resets anything that is there.
 */

async function loadSeedEntries(imagesDir: string): Promise<SeedEntry[]> {
  return joinSeed(await readManifest(imagesDir, SeedManifest), SEED_IMAGES);
}

/**
 * Whether the object exists. Only existence matters, so the body is released unread (an S3 body holds a socket until
 * it is read or destroyed). A missing key is `false`; any other storage failure propagates.
 */
async function objectExists(storage: ObjectStorage, key: string): Promise<boolean> {
  try {
    const object = await storage.get(key);
    if (object.status === 'ok') object.body.destroy();
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return false;
    throw error;
  }
}

/** Original and preview of a seed row are both in storage. */
async function bothObjectsExist(storage: ObjectStorage, objectKey: string): Promise<boolean> {
  const found = await Promise.all([objectKey, previewKeyOf(objectKey)].map((key) => objectExists(storage, key)));
  return found.every(Boolean);
}

async function readSeedPhoto(imagesDir: string, slug: string): Promise<IncomingFile> {
  const buffer = await readFile(join(imagesDir, `${slug}.jpg`));
  return { buffer, size: buffer.length };
}

async function existingKeys(db: Database, objectKeys: readonly string[]): Promise<Set<string>> {
  const rows = await db
    .select({ objectKey: images.objectKey })
    .from(images)
    .where(inArray(images.objectKey, [...objectKeys]));
  return new Set(rows.map((row) => row.objectKey));
}

/**
 * Row and comments in one transaction (no storage call inside it, ADR 0008). `ON CONFLICT DO NOTHING` on the object
 * key: a concurrent seed run that inserted the same photo first wins, and this run inserts no duplicate comments.
 */
async function insertSeedRows(db: Database, image: SeedImage, stored: StoredImage): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(images)
      .values({
        objectKey: stored.objectKey,
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        sizeBytes: stored.sizeBytes,
        authorName: image.authorName,
        title: image.title,
        description: image.description,
        ownerId: SEED_OWNER_ID,
        createdAt: new Date(image.createdAt),
      })
      .onConflictDoNothing({ target: images.objectKey })
      .returning({ id: images.id });
    if (!row) return false;
    if (image.comments.length > 0) {
      await tx.insert(comments).values(
        image.comments.map((comment) => ({
          imageId: row.id,
          authorName: comment.authorName,
          body: comment.body,
          ownerId: SEED_OWNER_ID,
          createdAt: new Date(comment.createdAt),
        })),
      );
    }
    return true;
  });
}

export interface SeedDeps {
  db: Database;
  /** The real upload port (`createScriptUploadPort`), so seed photos get exactly the upload pipeline (ADR 0014). */
  upload: ImageUploadPort;
  /** The storage behind `upload`; read only, to find seed rows whose objects are gone. */
  storage: ObjectStorage;
  logger: Pick<Logger, 'info'>;
  /** Default `apps/api/seed/images/`. */
  imagesDir?: string;
}

export interface SeedResult {
  inserted: string[];
  /** Rows that existed without their original or preview; both objects were stored again under the same key. */
  restored: string[];
  skipped: string[];
}

/**
 * Idempotent demo content (F-63, DATA-MODEL §6.1). For each manifest photo in content order:
 * - a row with its fixed object key exists and both objects are in storage → skip it (two reads, no write);
 * - the row exists but an object is missing (for example after a storage volume was reset) → ingest the file again
 *   with the same key, which stores original and preview; the row and its comments stay as they are;
 * - no row → ingest the file through the upload pipeline with that key, then insert the row and its comments with
 *   fixed dates and the seed owner. If the insert fails, the objects are discarded again, unless a row for the key
 *   exists by then (another run owns them).
 */
export async function runSeed({
  db,
  upload,
  storage,
  logger,
  imagesDir = SEED_IMAGES_DIR,
}: SeedDeps): Promise<SeedResult> {
  const entries = await loadSeedEntries(imagesDir);
  const present = await existingKeys(
    db,
    entries.map((entry) => entry.file.objectKey),
  );
  const result: SeedResult = { inserted: [], restored: [], skipped: [] };

  for (const { image, file } of entries) {
    const rowExists = present.has(file.objectKey);
    if (rowExists && (await bothObjectsExist(storage, file.objectKey))) {
      result.skipped.push(image.slug);
      continue;
    }
    const stored = await upload.ingest(await readSeedPhoto(imagesDir, image.slug), { objectKey: file.objectKey });
    if (rowExists) {
      result.restored.push(image.slug);
      logger.info({ slug: image.slug, objectKey: file.objectKey }, 'seed image objects restored');
      continue;
    }
    let inserted: boolean;
    try {
      inserted = await insertSeedRows(db, image, stored);
    } catch (error) {
      // Compensation (ADR 0008). A failing lookup must not hide the original error; then the row is assumed absent.
      const insertedMeanwhile = await existingKeys(db, [stored.objectKey]).then(
        (keys) => keys.has(stored.objectKey),
        () => false,
      );
      if (!insertedMeanwhile) await upload.discard(stored.objectKey);
      throw error;
    }
    (inserted ? result.inserted : result.skipped).push(image.slug);
    logger.info({ slug: image.slug, objectKey: stored.objectKey, inserted }, 'seed image');
  }

  logger.info(
    { inserted: result.inserted.length, restored: result.restored.length, skipped: result.skipped.length },
    'seed finished',
  );
  return result;
}

export interface SeedCheckDeps {
  db: Database;
  storage: ObjectStorage;
  imagesDir?: string;
}

export interface SeedCheckResult {
  ok: boolean;
  /** Seed rows found / comments by the seed owner on them / objects reachable through `storage.get`. */
  images: number;
  comments: number;
  objects: number;
  expected: typeof SEED_TOTALS;
  problems: string[];
}

async function isReachable(storage: ObjectStorage, key: string): Promise<true | string> {
  try {
    return (await objectExists(storage, key)) || `object missing: ${key}`;
  } catch (error) {
    return `object unreadable: ${key} (${String(error)})`;
  }
}

/**
 * Read-only verification for `db:seed:check` (CI `dev-setup-smoke`): every manifest photo has its row (seed owner),
 * each row has exactly its comments by the seed owner (visitors' comments on demo images do not count), and both its
 * original and its preview are reachable in storage. Writes nothing.
 */
export async function checkSeed({ db, storage, imagesDir = SEED_IMAGES_DIR }: SeedCheckDeps): Promise<SeedCheckResult> {
  const entries = await loadSeedEntries(imagesDir);
  const problems: string[] = [];
  const rows = await db
    .select({ id: images.id, objectKey: images.objectKey })
    .from(images)
    .where(
      and(
        eq(images.ownerId, SEED_OWNER_ID),
        inArray(
          images.objectKey,
          entries.map((entry) => entry.file.objectKey),
        ),
      ),
    );
  const idByKey = new Map(rows.map((row) => [row.objectKey, row.id]));
  const commentCounts =
    rows.length === 0
      ? []
      : await db
          .select({ imageId: comments.imageId, total: count() })
          .from(comments)
          .where(
            and(
              eq(comments.ownerId, SEED_OWNER_ID),
              inArray(
                comments.imageId,
                rows.map((row) => row.id),
              ),
            ),
          )
          .groupBy(comments.imageId);
  const commentsById = new Map(commentCounts.map((row) => [row.imageId, row.total]));

  let commentTotal = 0;
  let reachable = 0;
  for (const { image, file } of entries) {
    const id = idByKey.get(file.objectKey);
    if (id === undefined) {
      problems.push(`row missing: ${image.slug} (${file.objectKey})`);
      continue;
    }
    const found = commentsById.get(id) ?? 0;
    commentTotal += found;
    if (found !== image.comments.length) {
      problems.push(`comments of ${image.slug}: ${String(found)}, expected ${String(image.comments.length)}`);
    }
    const statuses = await Promise.all(
      [file.objectKey, previewKeyOf(file.objectKey)].map((key) => isReachable(storage, key)),
    );
    for (const status of statuses) {
      if (status === true) reachable += 1;
      else problems.push(status);
    }
  }

  return {
    ok: problems.length === 0,
    images: rows.length,
    comments: commentTotal,
    objects: reachable,
    expected: SEED_TOTALS,
    problems,
  };
}
