import { randomUUID } from 'node:crypto';

import { fieldMessages, fileMessages, ImageDto, ImagePage, notOwnerMessages, requestMessages } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { png } from '../../../../test/fixtures.js';
import { agentWithSession, problemOf, type SessionAgent, sessionCookieLifetime } from '../../../../test/http.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { createTestDatabase, type TestDatabase } from '../../../../test/test-db.js';
import type { Database } from '../../../db/client.js';
import { comments, images } from '../../../db/schema/index.js';
import { InvalidImageError, UnsupportedImageTypeError } from '../../../shared/errors/app-error.js';
import { createFakeUploadPort, FAKE_MEDIA_BASE, fakePreviewKey } from './fakes.js';

/*
 * The real app (session, CSRF, limiters, the real multipart parser, Postgres, Redis) with a fake upload port
 * (ADR 0017). Real ingestion through POST /api/images is proven in test/flows/upload-flow.int.test.ts (phase 2.4).
 */

const DTO_KEYS = [
  'authorName',
  'canDelete',
  'createdAt',
  'description',
  'height',
  'id',
  'mimeType',
  'previewUrl',
  'title',
  'url',
  'width',
];
const DAY_SECONDS = 24 * 60 * 60;
const UPLOAD_MAX_BYTES = 1024 * 1024;
const INVALID_IDS = ['abc', '0', '-1', '1.5', '2147483648', '01', '1e3'];

const validFields = { authorName: 'Marit', title: 'Iris on the axis', description: 'Mirrored down the middle.' };

interface UploadParts {
  fields?: Readonly<Record<string, string>>;
  files?: readonly { field: string; content: Buffer; filename?: string }[];
}

/** A multipart upload as the SPA sends it: session cookie, CSRF header, text parts, then the file part. */
function postImage(
  { agent, csrfToken }: SessionAgent,
  { fields = validFields, files = [{ field: 'file', content: png() }] }: UploadParts = {},
) {
  let pending = agent.post('/api/images').set('x-csrf-token', csrfToken);
  for (const [name, value] of Object.entries(fields)) pending = pending.field(name, value);
  for (const file of files) {
    pending = pending.attach(file.field, file.content, {
      filename: file.filename ?? 'photo.png',
      contentType: 'image/png',
    });
  }
  return pending;
}

async function imageRow(db: Database, id: number) {
  const [row] = await db
    .select({ objectKey: images.objectKey, ownerId: images.ownerId, description: images.description })
    .from(images)
    .where(eq(images.id, id));
  return row;
}

async function countImages(db: Database): Promise<number> {
  return (await db.select({ id: images.id }).from(images)).length;
}

function expectNoStore(response: request.Response): void {
  expect(response.headers['cache-control']).toBe('no-store');
}

describe('images routes', () => {
  const upload = createFakeUploadPort();
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ upload, env: { UPLOAD_MAX_BYTES: String(UPLOAD_MAX_BYTES) } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(() => {
    upload.reset();
  });

  describe('POST /api/images', () => {
    it('F-25 / F-21: 201 with Location, canDelete true and only the bytes handed to the upload port', async () => {
      const session = await agentWithSession(testApp.app);
      const content = png();

      const response = await postImage(session, {
        files: [{ field: 'file', content, filename: '../../etc/passwd.png' }],
      });

      expect(response.status).toBe(201);
      expectNoStore(response);
      const dto = ImageDto.parse(response.body);
      expect(Object.keys(response.body as object).sort()).toEqual(DTO_KEYS);
      expect(response.headers['location']).toBe(`/api/images/${String(dto.id)}`);
      expect(dto).toMatchObject({ ...validFields, canDelete: true, mimeType: 'image/png', width: 640, height: 480 });

      expect(upload.ingested).toHaveLength(1);
      const handedOver = upload.ingested[0]!;
      expect(Object.keys(handedOver.file).sort()).toEqual(['buffer', 'size']);
      expect(Buffer.compare(handedOver.file.buffer, content)).toBe(0);
      expect(handedOver.file.size).toBe(content.length);
      expect(handedOver.options).toBeUndefined();

      const row = await imageRow(testApp.db, dto.id);
      expect(dto.url).toBe(`${FAKE_MEDIA_BASE}/${row!.objectKey}`);
      expect(dto.previewUrl).toBe(`${FAKE_MEDIA_BASE}/${fakePreviewKey(row!.objectKey)}`);
      // F-43: the owner identity never leaves the server.
      expect(JSON.stringify(response.body)).not.toContain(row!.ownerId);
    });

    it('F-34: the first upload promotes the provisional session to its full lifetime', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session);

      expect(response.status).toBe(201);
      const lifetime = sessionCookieLifetime(response);
      expect(lifetime).toBeGreaterThanOrEqual(180 * DAY_SECONDS - 1);
      expect(lifetime).toBeLessThanOrEqual(180 * DAY_SECONDS + 1);
    });

    it('F-18: CRLF in the description is stored as LF; a missing description is stored as ""', async () => {
      const session = await agentWithSession(testApp.app);

      const withBreaks = await postImage(session, {
        fields: { ...validFields, description: '  Line one\r\nLine two\rLine three  ' },
      });
      const without = await postImage(session, { fields: { authorName: 'wen', title: 'Second coffee' } });

      expect(withBreaks.status).toBe(201);
      expect(ImageDto.parse(withBreaks.body).description).toBe('Line one\nLine two\nLine three');
      expect((await imageRow(testApp.db, ImageDto.parse(withBreaks.body).id))?.description).toBe(
        'Line one\nLine two\nLine three',
      );
      expect(without.status).toBe(201);
      expect(ImageDto.parse(without.body).description).toBe('');
    });

    it('B-24 / F-18: missing fields and a missing file are reported together and nothing is stored', async () => {
      const session = await agentWithSession(testApp.app);
      const before = await countImages(testApp.db);

      const response = await postImage(session, { fields: { description: 'only this' }, files: [] });

      expect(response.status).toBe(400);
      const problem = problemOf(response);
      expect(problem.code).toBe('validation-failed');
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          { field: 'authorName', location: 'body', message: fieldMessages.authorName.required },
          { field: 'title', location: 'body', message: fieldMessages.title.required },
          { field: 'file', location: 'file', message: fileMessages.required },
        ]),
      );
      expect(problem.errors).toHaveLength(3);
      expect(upload.ingested).toEqual([]);
      expect(await countImages(testApp.db)).toBe(before);
    });

    it('B-24: valid fields without a file is 400 on the file', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, { files: [] });

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([{ field: 'file', location: 'file', message: fileMessages.required }]);
      expect(upload.ingested).toEqual([]);
    });

    it('B-24: the part a browser sends for a file input without a file counts as no file', async () => {
      const { agent, csrfToken } = await agentWithSession(testApp.app);
      // Exactly what a <form> sends: a file part with filename="" and no content. (Supertest cannot produce it: it
      // drops an empty filename and turns the part into a text field.)
      const boundary = 'imageboard-test-boundary';
      const body = [
        ...Object.entries(validFields).map(
          ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename=""\r\n`,
        'Content-Type: application/octet-stream\r\n\r\n\r\n',
        `--${boundary}--\r\n`,
      ].join('');

      const response = await agent
        .post('/api/images')
        .set('x-csrf-token', csrfToken)
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(body);

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([{ field: 'file', location: 'file', message: fileMessages.required }]);
      expect(upload.ingested).toEqual([]);
    });

    it('B-24: a chosen file with zero bytes counts as no file', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, {
        files: [{ field: 'file', content: Buffer.alloc(0), filename: 'empty.png' }],
      });

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([{ field: 'file', location: 'file', message: fileMessages.required }]);
      expect(upload.ingested).toEqual([]);
    });

    it.each([
      ['a line break in the title', { title: 'Fog\nover the pines' }, 'title', fieldMessages.title.invalid],
      ['a title over 120 characters', { title: 'x'.repeat(121) }, 'title', fieldMessages.title.tooLong],
      ['a blank name', { authorName: ' \t ' }, 'authorName', fieldMessages.authorName.required],
      ['a name over 60 code points', { authorName: '🌲'.repeat(61) }, 'authorName', fieldMessages.authorName.tooLong],
    ])('F-18: %s is 400 on that field and nothing is ingested', async (_label, override, field, message) => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, { fields: { ...validFields, ...override } });

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([{ field, location: 'body', message }]);
      expect(upload.ingested).toEqual([]);
    });

    it('F-18: limits are applied to trimmed values (120 code points plus surrounding spaces pass)', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, { fields: { ...validFields, title: `  ${'é'.repeat(120)}  ` } });

      expect(response.status).toBe(201);
      expect(ImageDto.parse(response.body).title).toBe('é'.repeat(120));
    });

    it('F-21 / B-02: an unknown text field (e.g. ownerId) is 400 "This field is not allowed."', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, {
        fields: { authorName: 'Marit', title: 'Mine now', ownerId: randomUUID() },
      });

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([
        { field: 'ownerId', location: 'body', message: requestMessages.unknownField },
      ]);
      expect(upload.ingested).toEqual([]);
    });

    it.each([
      ['a fourth text field', { fields: { ...validFields, extra: 'x' } }],
      [
        'a second file',
        {
          files: [
            { field: 'file', content: png() },
            { field: 'file', content: png() },
          ],
        },
      ],
      ['a file under another field name', { files: [{ field: 'image', content: png() }] }],
    ])('F-21: %s is 400 malformed-request', async (_label, parts) => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, parts);

      expect(response.status).toBe(400);
      expect(problemOf(response).code).toBe('malformed-request');
      expect(upload.ingested).toEqual([]);
    });

    it('F-18: a text part over 16 KiB is 400 on that field with its own message', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, { fields: { ...validFields, description: 'x'.repeat(17 * 1024) } });

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([
        { field: 'description', location: 'body', message: fieldMessages.description.tooLong },
      ]);
      expect(upload.ingested).toEqual([]);
    });

    it('F-20: a file over UPLOAD_MAX_BYTES is 413 with the size message and never reaches the port', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session, {
        files: [{ field: 'file', content: Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0xff) }],
      });

      expect(response.status).toBe(413);
      const problem = problemOf(response);
      expect(problem.code).toBe('payload-too-large');
      expect(problem.detail).toBe('The image must be 1 MB or smaller.');
      expect(upload.ingested).toEqual([]);
    });

    it('API §2: a JSON body is 415 unsupported-content-type', async () => {
      const { agent, csrfToken } = await agentWithSession(testApp.app);

      const response = await agent.post('/api/images').set('x-csrf-token', csrfToken).send(validFields);

      expect(response.status).toBe(415);
      expect(problemOf(response).code).toBe('unsupported-content-type');
      expect(upload.ingested).toEqual([]);
    });

    it.each([
      ['415 unsupported-image-type', new UnsupportedImageTypeError(), 415, 'unsupported-image-type'],
      ['400 invalid-image', new InvalidImageError(fileMessages.tooManyPixels), 400, 'invalid-image'],
    ])('F-19: an ingest rejection (%s) reaches the client and no row is written', async (_l, error, status, code) => {
      const session = await agentWithSession(testApp.app);
      const before = await countImages(testApp.db);
      upload.behaviour.ingestError = error;

      const response = await postImage(session);

      expect(response.status).toBe(status);
      const problem = problemOf(response);
      expect(problem.code).toBe(code);
      expect(problem.detail).toBe(error.message);
      expect(await countImages(testApp.db)).toBe(before);
      expect(upload.discarded).toEqual([]);
    });

    it('F-23 / B-25: a failing insert discards the stored objects and answers a generic 500', async () => {
      const session = await agentWithSession(testApp.app);
      const before = await countImages(testApp.db);
      // A key whose extension contradicts the detected type violates images_object_key_matches_mime (a server bug).
      const objectKey = `images/${randomUUID()}.png`;
      upload.behaviour.stored = { objectKey, mimeType: 'image/jpeg' };

      const response = await postImage(session);

      expect(response.status).toBe(500);
      const problem = problemOf(response);
      expect(problem.code).toBe('internal-error');
      expect(problem.detail).toBe('An unexpected error occurred.');
      expect(JSON.stringify(problem)).not.toMatch(/images_object_key|violates|constraint|insert/i);
      expect(upload.discarded).toEqual([objectKey]);
      expect(upload.storedKeys()).toEqual([]);
      expect(await countImages(testApp.db)).toBe(before);
    });

    it('F-39: without a CSRF token the upload is 403 csrf-invalid', async () => {
      const { agent } = await agentWithSession(testApp.app);

      const response = await agent.post('/api/images').field('authorName', 'Marit').attach('file', png(), 'a.png');

      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('csrf-invalid');
      expect(upload.ingested).toEqual([]);
    });

    it('F-39: a visitor without a session is 403 csrf-invalid', async () => {
      const response = await request(testApp.app).post('/api/images').attach('file', png(), 'a.png');

      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('csrf-invalid');
    });

    it('B-03: a cross-site upload is 403 cross-origin-request even with a valid token', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await postImage(session).set('Sec-Fetch-Site', 'cross-site');

      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('cross-origin-request');
      expect(upload.ingested).toEqual([]);
    });
  });

  describe('GET /api/images/:id', () => {
    it('F-43: 200 with exactly the DTO keys; canDelete only for the owning session', async () => {
      const owner = await agentWithSession(testApp.app);
      const created = ImageDto.parse((await postImage(owner)).body);
      const row = await imageRow(testApp.db, created.id);

      const asOwner = await owner.agent.get(`/api/images/${String(created.id)}`);
      const asStranger = await (await agentWithSession(testApp.app)).agent.get(`/api/images/${String(created.id)}`);
      const anonymous = await request(testApp.app).get(`/api/images/${String(created.id)}`);

      expect(asOwner.status).toBe(200);
      expectNoStore(asOwner);
      expect(Object.keys(asOwner.body as object).sort()).toEqual(DTO_KEYS);
      expect(asOwner.body).toEqual(created);
      expect(ImageDto.parse(asStranger.body)).toEqual({ ...created, canDelete: false });
      expect(ImageDto.parse(anonymous.body)).toEqual({ ...created, canDelete: false });
      for (const response of [asOwner, asStranger, anonymous]) {
        expect(JSON.stringify(response.body)).not.toContain(row!.ownerId);
        expect(JSON.stringify(response.body)).not.toMatch(/owner|sizeBytes|objectKey/i);
      }
    });

    it('F-13 / B-21: an unknown id is 404 not-found problem+json', async () => {
      const response = await request(testApp.app).get('/api/images/2147483647');

      expect(response.status).toBe(404);
      const problem = problemOf(response);
      expect(problem).toMatchObject({ code: 'not-found', status: 404, detail: 'Image was not found.' });
      expect(problem.instance).toBe('/api/images/2147483647');
    });

    it.each(INVALID_IDS)('F-44 / B-13: id %j is 400 validation-failed on the id', async (id) => {
      const response = await request(testApp.app).get(`/api/images/${id}`);

      expect(response.status).toBe(400);
      const problem = problemOf(response);
      expect(problem.code).toBe('validation-failed');
      expect(problem.errors).toEqual([{ field: 'id', location: 'params', message: requestMessages.invalidId }]);
      expect(JSON.stringify(problem)).not.toMatch(/stack|syntax|22P02|22003/i);
    });
  });

  describe('DELETE /api/images/:id', () => {
    async function createOwned(owner: SessionAgent): Promise<{ id: number; objectKey: string }> {
      const created = ImageDto.parse((await postImage(owner)).body);
      const row = await imageRow(testApp.db, created.id);
      upload.reset();
      return { id: created.id, objectKey: row!.objectKey };
    }

    it('F-35 / F-36 / F-D2 / B-23: the owner gets 204, the row and its comments are gone, objects discarded', async () => {
      const owner = await agentWithSession(testApp.app);
      const { id, objectKey } = await createOwned(owner);
      await testApp.db.insert(comments).values([
        { imageId: id, authorName: 'Henrik', body: 'The little curls on the stems are lovely.', ownerId: randomUUID() },
        { imageId: id, authorName: 'Bea', body: 'Exactly what I needed.', ownerId: randomUUID() },
      ]);

      const response = await owner.agent.delete(`/api/images/${String(id)}`).set('x-csrf-token', owner.csrfToken);

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(response.headers['location']).toBeUndefined();
      expect(upload.discarded).toEqual([objectKey]);
      expect(await imageRow(testApp.db, id)).toBeUndefined();
      expect(await testApp.db.select({ id: comments.id }).from(comments).where(eq(comments.imageId, id))).toEqual([]);
      expect((await request(testApp.app).get(`/api/images/${String(id)}`)).status).toBe(404);
    });

    it('F-35 / B-02: another session gets 403 not-owner and the image stays', async () => {
      const owner = await agentWithSession(testApp.app);
      const stranger = await agentWithSession(testApp.app);
      const { id } = await createOwned(owner);

      const response = await stranger.agent.delete(`/api/images/${String(id)}`).set('x-csrf-token', stranger.csrfToken);

      expect(response.status).toBe(403);
      expect(problemOf(response)).toMatchObject({ code: 'not-owner', detail: notOwnerMessages.image });
      expect(await imageRow(testApp.db, id)).toBeDefined();
      expect(upload.discarded).toEqual([]);
    });

    it('F-35: an unknown id is 404 not-found', async () => {
      const session = await agentWithSession(testApp.app);

      const response = await session.agent.delete('/api/images/2147483647').set('x-csrf-token', session.csrfToken);

      expect(response.status).toBe(404);
      expect(problemOf(response).code).toBe('not-found');
    });

    it.each(INVALID_IDS)('F-44 / B-13: id %j is 400 validation-failed', async (id) => {
      const session = await agentWithSession(testApp.app);

      const response = await session.agent.delete(`/api/images/${id}`).set('x-csrf-token', session.csrfToken);

      expect(response.status).toBe(400);
      expect(problemOf(response).errors).toEqual([
        { field: 'id', location: 'params', message: requestMessages.invalidId },
      ]);
    });

    it('F-39: without a CSRF token the delete is 403 csrf-invalid and the image stays', async () => {
      const owner = await agentWithSession(testApp.app);
      const { id } = await createOwned(owner);

      const response = await owner.agent.delete(`/api/images/${String(id)}`);

      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('csrf-invalid');
      expect(await imageRow(testApp.db, id)).toBeDefined();
    });

    it('B-03: a cross-site delete is 403 cross-origin-request even with a valid token', async () => {
      const owner = await agentWithSession(testApp.app);
      const { id } = await createOwned(owner);

      const response = await owner.agent
        .delete(`/api/images/${String(id)}`)
        .set('x-csrf-token', owner.csrfToken)
        .set('Origin', 'https://evil.example');

      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('cross-origin-request');
      expect(await imageRow(testApp.db, id)).toBeDefined();
    });

    it('ADR 0008: a failing object cleanup is logged, not reported: the delete is still 204', async () => {
      const owner = await agentWithSession(testApp.app);
      const { id, objectKey } = await createOwned(owner);
      upload.behaviour.discardError = new Error('storage down');

      const response = await owner.agent.delete(`/api/images/${String(id)}`).set('x-csrf-token', owner.csrfToken);

      expect(response.status).toBe(204);
      expect(upload.discarded).toEqual([objectKey]);
      expect(await imageRow(testApp.db, id)).toBeUndefined();
    });
  });
});

describe('GET /api/images (a pristine database)', () => {
  const upload = createFakeUploadPort();
  const ownerId = randomUUID();
  let database: TestDatabase;
  let testApp: TestApp;
  /** Ids in insertion order: ids[0] is image id 1, the oldest. */
  const ids: number[] = [];
  /** One minute per inserted image, so insertion order is time order. */
  let minutes = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    testApp = await createTestApp({ upload, databaseUrl: database.url });
  });

  afterAll(async () => {
    await testApp.close();
    await database.drop();
  });

  async function insertImages(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const minute = String(minutes).padStart(2, '0');
      minutes += 1;
      const [row] = await testApp.db
        .insert(images)
        .values({
          objectKey: `images/${randomUUID()}.jpg`,
          mimeType: 'image/jpeg',
          width: 1600,
          height: 1067,
          sizeBytes: 1000,
          authorName: 'Sanne',
          title: `Image ${String(ids.length + 1)}`,
          ownerId,
          createdAt: new Date(`2026-10-06T15:${minute}:00.000Z`),
        })
        .returning({ id: images.id });
      ids.push(row!.id);
    }
  }

  async function listPage(query: string): Promise<{ response: request.Response; page: ImagePage }> {
    const response = await request(testApp.app).get(`/api/images${query}`);
    expect(response.status).toBe(200);
    return { response, page: ImagePage.parse(response.body) };
  }

  it('B-46 / F-07: an empty gallery is 200 with no items and nextCursor null', async () => {
    const { response, page } = await listPage('');

    expectNoStore(response);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('F-01 / F-02 / F-05: 12 newest first, nextCursor while older images exist, null on the last page', async () => {
    await insertImages(13);

    const first = await listPage('');
    expect(first.page.items.map((item) => item.id)).toEqual(ids.toReversed().slice(0, 12));
    expect(first.page.nextCursor).toEqual(expect.any(String));
    for (const item of first.page.items) {
      expect(Object.keys(item).sort()).toEqual(DTO_KEYS);
      expect(item.canDelete).toBe(false);
    }
    expect(JSON.stringify(first.response.body)).not.toContain(ownerId);

    const second = await listPage(`?cursor=${first.page.nextCursor ?? ''}`);
    expect(second.page.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.page.nextCursor).toBeNull();
  });

  it.each([
    ['0', 1],
    ['-5', 1],
    ['1', 1],
    ['1000', 13],
    ['', 12],
  ])('F-02: limit=%j is clamped to %d items', async (limit, expected) => {
    const { page } = await listPage(`?limit=${limit}`);

    expect(page.items).toHaveLength(expected);
  });

  it.each([
    ['limit=abc', 'limit', requestMessages.invalidLimit],
    ['limit=1.5', 'limit', requestMessages.invalidLimit],
    ['limit=1&limit=2', 'limit', requestMessages.invalidLimit],
    [`cursor=${'a'.repeat(201)}`, 'cursor', requestMessages.invalidCursor],
    ['page=2', 'page', requestMessages.unknownField],
  ])('F-44: ?%s is 400 validation-failed on %s', async (query, field, message) => {
    const response = await request(testApp.app).get(`/api/images?${query}`);

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([{ field, location: 'query', message }]);
  });

  it.each([
    'not-a-cursor',
    Buffer.from('{"t":"yesterday","id":1}').toString('base64url'),
    'eyJ0Ijo',
    // Decodes to a valid ISO timestamp that Postgres rejects as out of range: must not reach the query (B-13).
    Buffer.from('{"t":"0000-01-01T00:00:00.000Z","id":1}').toString('base64url'),
  ])('ADR 0007 / B-13: cursor %j that does not decode is 400 invalid-cursor', async (cursor) => {
    const response = await request(testApp.app).get(`/api/images?cursor=${cursor}`);

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('invalid-cursor');
  });

  it('B-46: after deleting the oldest image (id 1), 12 images fit one page and nextCursor is null', async () => {
    await testApp.db.delete(images).where(eq(images.id, ids[0]!));
    ids.shift();

    const { page } = await listPage('');

    expect(page.items).toHaveLength(12);
    expect(page.nextCursor).toBeNull();
  });

  it('F-04: inserts and deletes between two page requests never duplicate or skip an image', async () => {
    const first = await listPage('?limit=5');
    const shown = first.page.items.map((item) => item.id);

    // Between the two requests: a newer upload, a deletion of a shown image and of one not yet shown.
    await insertImages(1);
    await testApp.db.delete(images).where(eq(images.id, shown[1]!));
    const deletedUnseen = ids.toReversed()[7]!;
    await testApp.db.delete(images).where(eq(images.id, deletedUnseen));

    const second = await listPage(`?limit=50&cursor=${first.page.nextCursor ?? ''}`);
    const expected = ids.toReversed().filter((id) => !shown.includes(id) && id !== deletedUnseen && id !== ids.at(-1));
    expect(second.page.items.map((item) => item.id)).toEqual(expected);
    expect(second.page.nextCursor).toBeNull();
  });

  it('B-02: in the list, canDelete is true only for the uploading session', async () => {
    const owner = await agentWithSession(testApp.app);
    const created = ImageDto.parse((await postImage(owner)).body);

    const asOwner = ImagePage.parse((await owner.agent.get('/api/images?limit=1')).body);
    const anonymous = await listPage('?limit=1');

    expect(asOwner.items[0]).toMatchObject({ id: created.id, canDelete: true });
    expect(anonymous.page.items[0]).toMatchObject({ id: created.id, canDelete: false });
  });
});

describe('images routes: per-route rate limits', () => {
  const upload = createFakeUploadPort();
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({
      upload,
      env: { RATE_LIMIT_UPLOADS: '1', RATE_LIMIT_DELETES: '1' },
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-40: the uploads limiter answers 429 with Retry-After once the budget is used', async () => {
    const session = await agentWithSession(testApp.app);

    expect((await postImage(session)).status).toBe(201);
    const limited = await postImage(session);

    expect(limited.status).toBe(429);
    expect(problemOf(limited).code).toBe('rate-limited');
    expect(limited.headers['retry-after']).toEqual(expect.any(String));
    expect(upload.ingested).toHaveLength(1);
  });

  it('F-40: the deletes limiter answers 429 with Retry-After once the budget is used', async () => {
    const session = await agentWithSession(testApp.app);

    const first = await session.agent.delete('/api/images/2147483647').set('x-csrf-token', session.csrfToken);
    const limited = await session.agent.delete('/api/images/2147483647').set('x-csrf-token', session.csrfToken);

    expect(first.status).toBe(404);
    expect(limited.status).toBe(429);
    expect(problemOf(limited).code).toBe('rate-limited');
    expect(limited.headers['retry-after']).toEqual(expect.any(String));
  });
});

describe('images routes: global daily upload cap', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ upload: createFakeUploadPort(), env: { RATE_LIMIT_UPLOADS_GLOBAL_DAY: '1' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-40 / ADR 0019: one budget for all clients, so a second session is refused too', async () => {
    expect((await postImage(await agentWithSession(testApp.app))).status).toBe(201);

    const limited = await postImage(await agentWithSession(testApp.app));

    expect(limited.status).toBe(429);
    expect(problemOf(limited).code).toBe('rate-limited');
  });
});
