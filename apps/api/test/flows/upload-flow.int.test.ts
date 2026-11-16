import { fieldMessages, fileMessages, ImageDto, requestMessages, uploadTooLarge } from '@app/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { images } from '../../src/db/schema/index.js';
import { createFakeStorage, type FakeStorage } from '../fakes.js';
import { apng, gif, htmlAsPng, jpegWithGps, oversize, pdf, png, svg, webp } from '../fixtures.js';
import { agentWithSession, problemOf, type SessionAgent } from '../http.js';
import { createTestApp, type TestApp } from '../test-app.js';
import { createTestDatabase, type TestDatabase, withDatabase } from '../test-db.js';

/*
 * POST /api/images end to end (phase 2.4, ADR 0017): the real images module, the real upload module (sniff, sharp,
 * preview, keys) and the real media route, on Postgres, Redis and the fake object storage. The images and upload
 * modules' own tests use a fake port or call the port directly; this file proves they work together.
 */

const ORIGINAL_KEY =
  /^images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
const fields = { authorName: 'Marit', title: 'Fog over the pines', description: 'Took the early bus.' };

interface Upload {
  content: Buffer;
  filename?: string;
  contentType?: string;
  fields?: Readonly<Record<string, string>>;
}

/** Multipart as the SPA sends it. The client filename and Content-Type are deliberately misleading in some tests. */
function postImage({ agent, csrfToken }: SessionAgent, upload: Upload) {
  let pending = agent.post('/api/images').set('x-csrf-token', csrfToken);
  for (const [name, value] of Object.entries(upload.fields ?? fields)) pending = pending.field(name, value);
  return pending.attach('file', upload.content, {
    filename: upload.filename ?? 'photo.png',
    contentType: upload.contentType ?? 'image/png',
  });
}

/** `/api/media/images/<uuid>.<ext>` → `images/<uuid>.<ext>` (MEDIA_PUBLIC_BASE_URL is `/api/media` in tests). */
function keyOf(url: string): string {
  return url.replace(/^\/api\/media\//, '');
}

async function rowCount(testApp: TestApp): Promise<number> {
  return (await testApp.db.select({ id: images.id }).from(images)).length;
}

function expectNothingStored(storage: FakeStorage, before: { keys: string[]; puts: number }): void {
  expect(storage.keys()).toEqual(before.keys);
  expect(storage.calls().put).toBe(before.puts);
}

describe('upload flow: real upload module, fake object storage', () => {
  let storage: FakeStorage;
  let testApp: TestApp;
  let session: SessionAgent;

  const snapshot = () => ({ keys: storage.keys(), puts: storage.calls().put });

  beforeAll(async () => {
    storage = createFakeStorage();
    testApp = await createTestApp({ storage });
    session = await agentWithSession(testApp.app);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-21 / F-22 / F-25 / B-06: a JPEG is re-encoded, oriented, stripped of EXIF/GPS and stored under a server key', async () => {
    const response = await postImage(session, {
      content: jpegWithGps(),
      filename: '../../etc/passwd.php.png',
      contentType: 'image/png',
    });

    expect(response.status).toBe(201);
    const dto = ImageDto.parse(response.body);
    // Orientation 6 on a 32×16 photo: stored upright as 16×32. The detected type wins over the client's claim.
    expect(dto).toMatchObject({ ...fields, mimeType: 'image/jpeg', width: 16, height: 32, canDelete: true });
    const objectKey = keyOf(dto.url);
    expect(objectKey).toMatch(ORIGINAL_KEY);
    expect(objectKey.endsWith('.jpg')).toBe(true);
    expect(objectKey).not.toMatch(/passwd|php|png/);
    expect(storage.keys()).toEqual(expect.arrayContaining([objectKey, keyOf(dto.previewUrl)]));

    const original = await request(testApp.app).get(dto.url);
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toBe('image/jpeg');
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    const metadata = await sharp(original.body as Buffer).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 16, height: 32 });
    expect(metadata.exif).toBeUndefined();
    expect((original.body as Buffer).includes(Buffer.from('GPS'))).toBe(false);

    const [row] = await testApp.db
      .select({ objectKey: images.objectKey, sizeBytes: images.sizeBytes })
      .from(images)
      .where(eq(images.id, dto.id));
    expect(row).toEqual({ objectKey, sizeBytes: (original.body as Buffer).length });

    const preview = await request(testApp.app).get(dto.previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toBe('image/webp');
    expect((await sharp(preview.body as Buffer).metadata()).format).toBe('webp');
  });

  it.each([
    ['PNG', png(), 'image/png', 'png'],
    ['APNG (stored as a static PNG)', apng(), 'image/png', 'png'],
    ['WebP', webp(), 'image/webp', 'webp'],
    ['animated GIF', gif(3), 'image/gif', 'gif'],
  ])('F-19: %s is accepted and stored with its detected type', async (_label, content, mimeType, extension) => {
    const response = await postImage(session, { content, filename: 'upload.bin', contentType: 'application/pdf' });

    expect(response.status).toBe(201);
    const dto = ImageDto.parse(response.body);
    expect(dto.mimeType).toBe(mimeType);
    expect(keyOf(dto.url).endsWith(`.${extension}`)).toBe(true);
    const served = await request(testApp.app).get(dto.url);
    expect(served.headers['content-type']).toBe(mimeType);
    expect((await sharp(served.body as Buffer).metadata()).format).toBe(extension === 'jpg' ? 'jpeg' : extension);
  });

  it.each([
    ['SVG with a script', svg, 'drawing.svg', 'image/svg+xml'],
    ['HTML renamed to .png', htmlAsPng, 'photo.png', 'image/png'],
    ['PDF', pdf, 'scan.pdf', 'application/pdf'],
  ])('F-19 / B-04 / B-05: %s is 415 and nothing is stored', async (_label, content, filename, contentType) => {
    const before = snapshot();
    const rows = await rowCount(testApp);

    const response = await postImage(session, { content, filename, contentType });

    expect(response.status).toBe(415);
    expect(problemOf(response)).toMatchObject({ code: 'unsupported-image-type', detail: fileMessages.unsupportedType });
    expectNothingStored(storage, before);
    expect(await rowCount(testApp)).toBe(rows);
  });

  it('F-20 / B-11: a file over UPLOAD_MAX_BYTES is 413 problem+json, not an HTML error page, and nothing is stored', async () => {
    const before = snapshot();

    const response = await postImage(session, { content: oversize(), filename: 'huge.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(413);
    expect(problemOf(response)).toMatchObject({ code: 'payload-too-large', detail: uploadTooLarge(5 * 1024 * 1024) });
    expect(JSON.stringify(response.body)).not.toMatch(/MulterError|at .*\.js|stack/i);
    expectNothingStored(storage, before);
  });

  it('B-11: a text part over 16 KiB is 400 on that field, a second file is 400 malformed; nothing is stored', async () => {
    const before = snapshot();

    const tooLong = await postImage(session, {
      content: png(),
      fields: { ...fields, description: 'x'.repeat(16 * 1024 + 1) },
    });
    const twoFiles = await postImage(session, { content: png() }).attach('file', png(), {
      filename: 'second.png',
      contentType: 'image/png',
    });

    expect(tooLong.status).toBe(400);
    expect(problemOf(tooLong).errors).toEqual([
      { field: 'description', location: 'body', message: fieldMessages.description.tooLong },
    ]);
    expect(twoFiles.status).toBe(400);
    expect(problemOf(twoFiles)).toMatchObject({ code: 'malformed-request', detail: requestMessages.malformed });
    expectNothingStored(storage, before);
  });

  it('F-18 / B-24 / B-25: invalid fields are 400 before anything is decoded or stored', async () => {
    const before = snapshot();
    const rows = await rowCount(testApp);

    const response = await postImage(session, { content: jpegWithGps(), fields: { authorName: '  ', title: '' } });

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual(
      expect.arrayContaining([
        { field: 'authorName', location: 'body', message: fieldMessages.authorName.required },
        { field: 'title', location: 'body', message: fieldMessages.title.required },
      ]),
    );
    expectNothingStored(storage, before);
    expect(await rowCount(testApp)).toBe(rows);
  });

  it('F-21 / B-02: an unknown text field is 400 on that field, a fourth field is 400 malformed; nothing is stored', async () => {
    const before = snapshot();

    const unknown = await postImage(session, {
      content: png(),
      fields: { authorName: 'Marit', title: 'Mine now', ownerId: 'someone-else' },
    });
    const fourth = await postImage(session, { content: png(), fields: { ...fields, extra: 'x' } });

    expect(unknown.status).toBe(400);
    expect(problemOf(unknown).errors).toEqual([
      { field: 'ownerId', location: 'body', message: requestMessages.unknownField },
    ]);
    expect(fourth.status).toBe(400);
    expect(problemOf(fourth).code).toBe('malformed-request');
    expectNothingStored(storage, before);
  });

  it('F-18: a CRLF description at the limit is accepted (each CRLF counts as one line break)', async () => {
    // 2001 code points as sent, 2000 after `\r\n` → `\n`: exactly the limit.
    const description = `${'a'.repeat(999)}\r\n${'b'.repeat(1000)}`;

    const response = await postImage(session, { content: png(), fields: { ...fields, description } });

    expect(response.status).toBe(201);
    expect(ImageDto.parse(response.body).description).toBe(`${'a'.repeat(999)}\n${'b'.repeat(1000)}`);
  });

  it('F-25: the upload belongs to its session: canDelete for the uploader only', async () => {
    const response = await postImage(session, { content: png() });
    const { id } = ImageDto.parse(response.body);
    const other = await agentWithSession(testApp.app);

    const own = await session.agent.get(`/api/images/${String(id)}`);
    const foreign = await other.agent.get(`/api/images/${String(id)}`);

    expect(ImageDto.parse(own.body).canDelete).toBe(true);
    expect(ImageDto.parse(foreign.body).canDelete).toBe(false);
  });
});

describe('upload flow: storage failure (F-23, B-25)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ storage: createFakeStorage({ failPut: true }) });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-23: when storage refuses the object, the answer is a generic 500 and no row is written', async () => {
    const session = await agentWithSession(testApp.app);
    const rows = await rowCount(testApp);

    const response = await postImage(session, { content: png() });

    expect(response.status).toBe(500);
    expect(problemOf(response)).toMatchObject({ code: 'internal-error', detail: 'An unexpected error occurred.' });
    expect(JSON.stringify(response.body)).not.toContain('fake storage');
    expect(await rowCount(testApp)).toBe(rows);
  });
});

describe('upload flow: database failure after storing (F-23, B-25)', () => {
  let database: TestDatabase;
  let storage: FakeStorage;
  let testApp: TestApp;

  beforeAll(async () => {
    // A pristine clone with a trigger that refuses every image row: the insert fails after both objects were put.
    database = await createTestDatabase();
    await withDatabase(database.url, (client) =>
      client.query(`
        CREATE FUNCTION refuse_image_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'insert refused by the test'; END $$;
        CREATE TRIGGER refuse_image_insert BEFORE INSERT ON images FOR EACH ROW EXECUTE FUNCTION refuse_image_insert();
      `),
    );
    storage = createFakeStorage();
    testApp = await createTestApp({ storage, databaseUrl: database.url });
  });

  afterAll(async () => {
    await testApp.close();
    await database.drop();
  });

  it('F-23: a failing insert deletes the stored original and preview again and answers a generic 500', async () => {
    const session = await agentWithSession(testApp.app);

    const response = await postImage(session, { content: jpegWithGps() });

    expect(response.status).toBe(500);
    expect(problemOf(response).code).toBe('internal-error');
    expect(JSON.stringify(response.body)).not.toMatch(/refused|trigger|insert/i);
    expect(storage.calls().put).toBe(2);
    expect(storage.keys()).toEqual([]);
    expect(await rowCount(testApp)).toBe(0);
  });
});
