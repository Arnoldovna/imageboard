import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { CommentPage, CreateCommentBody, CreateImageFields, ImagePage } from '@app/shared';
import { and, asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { comments, images } from '../src/db/schema/index.js';
import { previewKeyOf } from '../src/features/upload/index.js';
import { seedMode } from '../src/scripts/seed-cli.js';
import {
  joinSeed,
  readManifest,
  SEED_IMAGES,
  SEED_IMAGES_DIR,
  SEED_OWNER_ID,
  SEED_TOTALS,
  SeedManifest,
} from '../src/scripts/seed-content.js';
import { createScriptUploadPort } from '../src/scripts/script-runtime.js';
import { checkSeed, runSeed } from '../src/scripts/seed.js';
import { createFakeStorage, type FakeStorage, silentLogger } from './fakes.js';
import { agentWithSession, problemOf } from './http.js';
import { createTestApp, type TestApp } from './test-app.js';
import { createTestDatabase, type TestDatabase, withDatabase } from './test-db.js';

/*
 * `pnpm db:seed` (F-63, B-44, ADR 0014, DATA-MODEL §6): the CLI guard, the committed content, and `runSeed` /
 * `checkSeed` with the real upload pipeline on fake storage. This file's own database makes the exact counts safe
 * (ADR 0015). CI's `dev-setup-smoke` repeats the check against real MinIO with `db:seed:check`.
 */

const SCRIPT_ENV = {
  UPLOAD_MAX_PIXELS: 40_000_000,
  UPLOAD_MAX_FRAMES: 200,
  IMAGE_MAX_EDGE: 2560,
  MEDIA_PUBLIC_BASE_URL: '/api/media',
};
const MINUTE = 60_000;

function seedDeps(db: TestApp['db'], storage: FakeStorage) {
  const logger = silentLogger();
  return { db, logger, storage, upload: createScriptUploadPort({ env: SCRIPT_ENV, storage, logger }) };
}

describe('seedMode (DATA-MODEL §6.1, ADR 0021 §5)', () => {
  it('F-63: a write run without SEED_ALLOW=true refuses', () => {
    for (const env of [{}, { SEED_ALLOW: '1' }, { SEED_ALLOW: 'TRUE' }, { SEED_ALLOW: 'yes' }]) {
      expect(() => seedMode([], env)).toThrow('Refusing to seed. Set SEED_ALLOW=true');
    }
  });

  it('never derives permission from NODE_ENV', () => {
    expect(() => seedMode([], { NODE_ENV: 'development' })).toThrow(/SEED_ALLOW/);
    expect(() => seedMode([], { NODE_ENV: 'test' })).toThrow(/SEED_ALLOW/);
    expect(seedMode([], { NODE_ENV: 'production', SEED_ALLOW: 'true' })).toBe('seed');
  });

  it('--check is read-only and needs no SEED_ALLOW', () => {
    expect(seedMode(['--check'], {})).toBe('check');
    expect(seedMode(['--', '--check'], {})).toBe('check');
    expect(seedMode(['--check'], { SEED_ALLOW: 'true' })).toBe('check');
  });

  it('an unknown argument is refused, so a typo never turns a check into a write run', () => {
    expect(() => seedMode(['--chek'], { SEED_ALLOW: 'true' })).toThrow(/Unknown argument/);
    expect(() => seedMode(['--check', '--reset'], {})).toThrow(/Unknown argument/);
  });
});

describe('seed content (DATA-MODEL §6.3 to §6.5)', () => {
  it('F-63: 16 images and 60 comments; one image without comments, one with 25', () => {
    expect(SEED_TOTALS).toEqual({ images: 16, comments: 60, objects: 32 });
    const counts = SEED_IMAGES.map((image) => image.comments.length);
    expect(counts.filter((n) => n === 0)).toHaveLength(1);
    expect(counts.filter((n) => n === 25)).toHaveLength(1);
    expect(SEED_IMAGES.find((image) => image.comments.length === 25)?.slug).toBe('north-sea-october');
  });

  it('every text passes the API contract unchanged (the same Zod schemas as uploads and comments)', () => {
    for (const image of SEED_IMAGES) {
      const fields = { authorName: image.authorName, title: image.title, description: image.description };
      expect(CreateImageFields.parse(fields)).toEqual(fields);
      for (const comment of image.comments) {
        const body = { authorName: comment.authorName, body: comment.body };
        expect(CreateCommentBody.parse(body)).toEqual(body);
      }
    }
  });

  it('fixed dates: images from 21 Sep to 12 Nov 2026 in order; comments 10 min to 3 days after, oldest first', () => {
    const times = SEED_IMAGES.map((image) => Date.parse(image.createdAt));
    expect(times[0]).toBe(Date.parse('2026-09-21T06:42:00.000Z'));
    expect(times.at(-1)).toBe(Date.parse('2026-11-12T19:23:00.000Z'));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const image of SEED_IMAGES) {
      const posted = Date.parse(image.createdAt);
      const commentTimes = image.comments.map((comment) => Date.parse(comment.createdAt));
      expect([...commentTimes].sort((a, b) => a - b)).toEqual(commentTimes);
      for (const time of commentTimes) {
        expect(time - posted).toBeGreaterThanOrEqual(10 * MINUTE);
        expect(time - posted).toBeLessThanOrEqual(3 * 24 * 60 * MINUTE);
      }
    }
  });

  it('B-44: the committed manifest credits every photo and every file is in the repository', async () => {
    const manifest = await readManifest(SEED_IMAGES_DIR, SeedManifest);
    const entries = joinSeed(manifest);

    expect(entries.map((entry) => entry.image.slug)).toEqual(SEED_IMAGES.map((image) => image.slug));
    for (const { image, file } of entries) {
      expect(file.sourceUrl).toMatch(/^https:\/\/unsplash\.com\/photos\//);
      expect(file.licence).toBe('Unsplash License');
      await expect(access(join(SEED_IMAGES_DIR, `${image.slug}.jpg`))).resolves.toBeUndefined();
    }
  });

  it('a manifest and content that disagree fail loudly instead of skipping a photo', async () => {
    const manifest = await readManifest(SEED_IMAGES_DIR, SeedManifest);

    expect(() => joinSeed(manifest.slice(1), SEED_IMAGES)).toThrow(
      'Without a photo: fog-over-the-pines; without content: -',
    );
    expect(() => joinSeed(manifest, SEED_IMAGES.slice(1))).toThrow(
      'Without a photo: -; without content: fog-over-the-pines',
    );
  });
});

describe('runSeed with the real upload pipeline on fake storage (F-63, B-37, B-44)', () => {
  let storage: FakeStorage;
  let testApp: TestApp;
  let firstRun: Awaited<ReturnType<typeof runSeed>>;

  beforeAll(async () => {
    storage = createFakeStorage();
    testApp = await createTestApp({ storage });
    firstRun = await runSeed(seedDeps(testApp.db, storage));
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function snapshotRows() {
    return {
      images: await testApp.db.select().from(images).orderBy(asc(images.id)),
      comments: await testApp.db.select().from(comments).orderBy(asc(comments.id)),
    };
  }

  it('F-63: the first run inserts 16 images with 60 comments and stores 32 objects', async () => {
    const manifest = await readManifest(SEED_IMAGES_DIR, SeedManifest);
    const { images: imageRows, comments: commentRows } = await snapshotRows();

    expect(firstRun.inserted).toEqual(SEED_IMAGES.map((image) => image.slug));
    expect(firstRun.restored).toEqual([]);
    expect(firstRun.skipped).toEqual([]);
    expect(imageRows).toHaveLength(16);
    expect(commentRows).toHaveLength(60);
    const expectedKeys = manifest.flatMap((entry) => [entry.objectKey, previewKeyOf(entry.objectKey)]);
    expect(storage.keys()).toEqual(expectedKeys.sort());

    for (const [index, image] of SEED_IMAGES.entries()) {
      const row = imageRows[index];
      expect(row).toMatchObject({
        title: image.title,
        authorName: image.authorName,
        description: image.description,
        createdAt: new Date(image.createdAt),
        ownerId: SEED_OWNER_ID,
        mimeType: 'image/jpeg',
        objectKey: manifest.find((entry) => entry.slug === image.slug)?.objectKey,
      });
      // Real values of the stored object (DATA-MODEL §6.6), not of the file in the repository.
      expect(Math.max(row?.width ?? 0, row?.height ?? 0)).toBeLessThanOrEqual(1600);
      expect(row?.sizeBytes).toBeGreaterThan(0);
    }
    expect(commentRows.every((row) => row.ownerId === SEED_OWNER_ID)).toBe(true);
  });

  it('F-63 / B-37: a second run inserts nothing, stores nothing and leaves every row as it was', async () => {
    const before = await snapshotRows();
    const callsBefore = storage.calls();

    const secondRun = await runSeed(seedDeps(testApp.db, storage));

    expect(secondRun).toEqual({ inserted: [], restored: [], skipped: SEED_IMAGES.map((image) => image.slug) });
    expect(await snapshotRows()).toEqual(before);
    // Only reads: original and preview of each of the 16 rows are looked up, nothing is put or deleted.
    expect(storage.calls()).toEqual({ ...callsBefore, get: callsBefore.get + 32 });
    expect(storage.keys()).toHaveLength(32);
  });

  it('F-63: a row whose objects are gone (e.g. a reset storage volume) gets them back; rows stay untouched', async () => {
    const manifest = await readManifest(SEED_IMAGES_DIR, SeedManifest);
    const fog = manifest.find((entry) => entry.slug === 'fog-over-the-pines');
    const balconies = manifest.find((entry) => entry.slug === 'balconies');
    await storage.delete(fog?.objectKey ?? '');
    await storage.delete(previewKeyOf(fog?.objectKey ?? ''));
    await storage.delete(previewKeyOf(balconies?.objectKey ?? ''));
    const before = await snapshotRows();
    const callsBefore = storage.calls();

    const run = await runSeed(seedDeps(testApp.db, storage));

    expect(run.inserted).toEqual([]);
    expect(run.restored).toEqual(['fog-over-the-pines', 'balconies']);
    expect(run.skipped).toHaveLength(14);
    expect(storage.calls().put).toBe(callsBefore.put + 4);
    expect(storage.calls().delete).toBe(callsBefore.delete);
    expect(storage.keys()).toHaveLength(32);
    expect(await snapshotRows()).toEqual(before);
    expect((await checkSeed({ db: testApp.db, storage })).ok).toBe(true);
  });

  it('checkSeed (db:seed:check) reports 16 images, 60 comments and 32 reachable objects', async () => {
    const result = await checkSeed({ db: testApp.db, storage });

    expect(result).toEqual({
      ok: true,
      images: 16,
      comments: 60,
      objects: 32,
      expected: { images: 16, comments: 60, objects: 32 },
      problems: [],
    });
  });

  it('B-44: the API serves the seed from its own storage: newest first, 12 per page, "Load more" available', async () => {
    const response = await request(testApp.app).get('/api/images');

    const page = ImagePage.parse(response.body);
    expect(page.items).toHaveLength(12);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]?.title).toBe('Rooftops from the fifth floor');
    expect(page.items.every((item) => !item.canDelete)).toBe(true);
    const first = page.items[0];
    expect(first?.url).toMatch(/^\/api\/media\/images\/[0-9a-f-]{36}\.jpg$/);
    const original = await request(testApp.app).get(first?.url ?? '');
    const preview = await request(testApp.app).get(first?.previewUrl ?? '');
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(original.body as Buffer).metadata()).exif).toBeUndefined();
    expect(preview.headers['content-type']).toBe('image/webp');
  });

  it('F-31: the image with 25 comments shows 20 and offers older ones; the image without comments is empty', async () => {
    const [northSea] = await testApp.db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.title, 'North Sea in October'));
    const [coffee] = await testApp.db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.title, 'Second coffee, first idea'));

    const busy = CommentPage.parse(
      (await request(testApp.app).get(`/api/images/${String(northSea?.id)}/comments`)).body,
    );
    const empty = CommentPage.parse(
      (await request(testApp.app).get(`/api/images/${String(coffee?.id)}/comments`)).body,
    );

    expect(busy.items).toHaveLength(20);
    expect(busy.items[0]?.body).toBe('Same. It is very calm to look at.');
    expect(busy.nextCursor).not.toBeNull();
    expect(empty).toEqual({ items: [], nextCursor: null });
  });

  it('F-35: visitors cannot delete demo content (SEED_OWNER_ID is never a session id)', async () => {
    const [row] = await testApp.db.select({ id: images.id }).from(images).limit(1);
    const { agent, csrfToken } = await agentWithSession(testApp.app);

    const response = await agent.delete(`/api/images/${String(row?.id)}`).set('x-csrf-token', csrfToken);

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('not-owner');
  });

  it('checkSeed ignores comments that visitors add to demo images', async () => {
    const [row] = await testApp.db.select({ id: images.id }).from(images).limit(1);
    const { agent, csrfToken } = await agentWithSession(testApp.app);
    await agent
      .post(`/api/images/${String(row?.id)}/comments`)
      .set('x-csrf-token', csrfToken)
      .send({ authorName: 'Visitor', body: 'Lovely.' });

    expect((await checkSeed({ db: testApp.db, storage })).ok).toBe(true);
  });

  // Last in this block: it breaks the seeded state on purpose.
  it('checkSeed reports a missing object and a missing comment, and only reads', async () => {
    const manifest = await readManifest(SEED_IMAGES_DIR, SeedManifest);
    const fog = manifest.find((entry) => entry.slug === 'fog-over-the-pines');
    const [fogRow] = await testApp.db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.objectKey, fog?.objectKey ?? ''));
    const [oneComment] = await testApp.db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.imageId, fogRow?.id ?? 0), eq(comments.ownerId, SEED_OWNER_ID)))
      .limit(1);
    await testApp.db.delete(comments).where(eq(comments.id, oneComment?.id ?? 0));
    await storage.delete(previewKeyOf(fog?.objectKey ?? ''));
    const callsBefore = storage.calls();

    const result = await checkSeed({ db: testApp.db, storage });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ images: 16, comments: 59, objects: 31 });
    expect(result.problems).toEqual([
      'comments of fog-over-the-pines: 1, expected 2',
      `object missing: ${previewKeyOf(fog?.objectKey ?? '')}`,
    ]);
    expect(storage.calls().put).toBe(callsBefore.put);
    expect(storage.calls().delete).toBe(callsBefore.delete);
  });
});

describe('checkSeed on an unseeded database', () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    database = await createTestDatabase();
    handle = createDatabase(database.url, silentLogger());
  });

  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  it('is not ok and names every missing row', async () => {
    const result = await checkSeed({ db: handle.db, storage: createFakeStorage() });

    expect(result).toMatchObject({ ok: false, images: 0, comments: 0, objects: 0 });
    expect(result.problems).toHaveLength(16);
    expect(result.problems[0]).toMatch(/^row missing: fog-over-the-pines \(images\/[0-9a-f-]{36}\.jpg\)$/);
  });
});

describe('runSeed when the insert fails (ADR 0008 compensation)', () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    database = await createTestDatabase();
    await withDatabase(database.url, (client) =>
      client.query(`
        CREATE FUNCTION refuse_image_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'insert refused by the test'; END $$;
        CREATE TRIGGER refuse_image_insert BEFORE INSERT ON images FOR EACH ROW EXECUTE FUNCTION refuse_image_insert();
      `),
    );
    handle = createDatabase(database.url, silentLogger());
  });

  afterAll(async () => {
    await handle.close();
    await database.drop();
  });

  it('F-23: the run stops with the error, and the original and preview of that photo are deleted again', async () => {
    const storage = createFakeStorage();

    await expect(runSeed(seedDeps(handle.db, storage))).rejects.toThrow();

    expect(storage.calls().put).toBe(2);
    expect(storage.keys()).toEqual([]);
    expect(await handle.db.select().from(comments)).toEqual([]);
  });
});
