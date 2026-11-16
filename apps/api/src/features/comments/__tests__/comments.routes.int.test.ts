import { CommentDto, CommentPage, fieldMessages, notOwnerMessages, requestMessages } from '@app/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentWithSession, problemOf, type SessionAgent, sessionCookieLifetime } from '../../../../test/http.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { createTestDatabase, type TestDatabase } from '../../../../test/test-db.js';
import { deleteImage, insertComments, insertImage, insertTimeline } from './fakes.js';

/*
 * The comment endpoints through the real app (ADR 0017): Postgres and Redis from Testcontainers, every app-level
 * middleware (global limiter, fetch-metadata guard, JSON parser, session, CSRF) in front of the comments routers.
 * Images are inserted directly; the images module is not under test here.
 */

const DAY_SECONDS = 24 * 60 * 60;
const DTO_KEYS = ['authorName', 'body', 'canDelete', 'createdAt', 'id', 'imageId'];
const INVALID_IDS = ['abc', '0', '-1', '1.5', '01', '1e3', '2147483648'];

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const commentsPath = (imageId: number | string) => `/api/images/${String(imageId)}/comments`;

function postComment(session: SessionAgent, imageId: number | string, body: object) {
  return session.agent.post(commentsPath(imageId)).set('x-csrf-token', session.csrfToken).send(body);
}

function deleteComment(session: SessionAgent, id: number | string) {
  return session.agent.delete(`/api/comments/${String(id)}`).set('x-csrf-token', session.csrfToken);
}

/** Problem bodies never carry stacks, SQL or driver details (F-41). */
function expectSafeProblem(response: request.Response): void {
  expect(JSON.stringify(response.body)).not.toMatch(
    /\bat .+:\d+|select |insert |delete from|23503|23514|drizzle|stack/i,
  );
}

describe('GET /api/images/:imageId/comments', () => {
  it('F-30: an image without comments answers an empty page', async () => {
    const imageId = await insertImage(testApp.db);

    const response = await request(testApp.app).get(commentsPath(imageId));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('F-27 / B-41: newest first (created_at DESC, id DESC), in exactly the DTO shape', async () => {
    const imageId = await insertImage(testApp.db);
    const later = new Date('2026-10-06T16:00:00.000Z');
    const [oldest, tieA, tieB] = await insertComments(testApp.db, [
      {
        imageId,
        authorName: 'Marit',
        body: 'That sky is doing a lot of work.',
        createdAt: new Date('2026-10-06T15:52:00.000Z'),
      },
      { imageId, authorName: 'Kofi', body: 'Which beach is this?', createdAt: later },
      { imageId, authorName: 'Sanne', body: 'A long way past the last car park.', createdAt: later },
    ]);

    const response = await request(testApp.app).get(commentsPath(imageId));
    const page = CommentPage.parse(response.body);

    expect(response.status).toBe(200);
    expect(page.items.map((item) => item.id)).toEqual([tieB, tieA, oldest]);
    expect(page.items[2]).toEqual({
      id: oldest,
      imageId,
      authorName: 'Marit',
      body: 'That sky is doing a lot of work.',
      createdAt: '2026-10-06T15:52:00.000Z',
      canDelete: false,
    });
    // The raw body, not the parsed one: CommentPage strips unknown keys, and the API must not send any (F-43).
    for (const item of (response.body as { items: object[] }).items) expect(Object.keys(item).sort()).toEqual(DTO_KEYS);
  });

  it('F-43: owner ids never appear in a response', async () => {
    const imageId = await insertImage(testApp.db);
    const ownerId = '7b1f7c2e-1d3a-4c55-9a0e-6f2b8c4d1e01';
    await insertComments(testApp.db, [{ imageId, ownerId }]);

    const response = await request(testApp.app).get(commentsPath(imageId));

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toMatch(/owner/i);
    expect(JSON.stringify(response.body)).not.toContain(ownerId);
  });

  it('B-26: an unknown image is 404 not-found', async () => {
    const response = await request(testApp.app).get(commentsPath(2_147_483_647));

    expect(response.status).toBe(404);
    expect(problemOf(response)).toMatchObject({ code: 'not-found', detail: 'Image was not found.' });
    // API JSON is never cached, problem bodies included (API.md §0).
    expect(response.headers['cache-control']).toBe('no-store');
    expectSafeProblem(response);
  });

  it('F-44: an invalid image id is 400 validation-failed on the imageId param', async () => {
    for (const id of INVALID_IDS) {
      const response = await request(testApp.app).get(commentsPath(id));

      expect(response.status, id).toBe(400);
      expect(problemOf(response)).toMatchObject({
        code: 'validation-failed',
        errors: [{ field: 'imageId', location: 'params', message: requestMessages.invalidId }],
      });
    }
  });

  it('F-44: a non-integer limit, an undecodable cursor and unknown query keys are 400', async () => {
    const imageId = await insertImage(testApp.db);

    const badLimit = await request(testApp.app).get(`${commentsPath(imageId)}?limit=abc`);
    expect(badLimit.status).toBe(400);
    expect(problemOf(badLimit)).toMatchObject({
      code: 'validation-failed',
      errors: [{ field: 'limit', location: 'query' }],
    });

    const badCursor = await request(testApp.app).get(`${commentsPath(imageId)}?cursor=bm90LWEtY3Vyc29y`);
    expect(badCursor.status).toBe(400);
    expect(problemOf(badCursor).code).toBe('invalid-cursor');
    expectSafeProblem(badCursor);

    const longCursor = await request(testApp.app).get(`${commentsPath(imageId)}?cursor=${'a'.repeat(201)}`);
    expect(longCursor.status).toBe(400);
    expect(problemOf(longCursor).errors).toEqual([
      { field: 'cursor', location: 'query', message: requestMessages.invalidCursor },
    ]);

    const unknownKey = await request(testApp.app).get(`${commentsPath(imageId)}?sort=asc`);
    expect(unknownKey.status).toBe(400);
    expect(problemOf(unknownKey).errors).toEqual([
      { field: 'sort', location: 'query', message: requestMessages.unknownField },
    ]);
  });

  it('HEAD answers like GET without a body', async () => {
    const imageId = await insertImage(testApp.db);

    const response = await request(testApp.app).head(commentsPath(imageId));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('comment pages (F-31, B-45) in a pristine database', () => {
  let database: TestDatabase;
  let pristine: TestApp;
  let imageId: number;
  let ids: number[];

  beforeAll(async () => {
    database = await createTestDatabase();
    pristine = await createTestApp({ databaseUrl: database.url });
    imageId = await insertImage(pristine.db);
    ids = await insertTimeline(pristine.db, imageId, 25);
  });

  afterAll(async () => {
    await pristine.close();
    await database.drop();
  });

  it('F-31 / B-45: 20 per page by default, nextCursor while older comments exist, every comment once', async () => {
    const first = await request(pristine.app).get(commentsPath(imageId));
    const firstPage = CommentPage.parse(first.body);
    expect(first.status).toBe(200);
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await request(pristine.app).get(
      `${commentsPath(imageId)}?cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    const secondPage = CommentPage.parse(second.body);
    expect(second.status).toBe(200);
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextCursor).toBeNull();

    expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).toEqual([...ids].reverse());
  });

  it('F-02: limit is clamped to 1..50 and an empty limit means the default', async () => {
    const extra = await insertTimeline(pristine.db, imageId, 30, Date.UTC(2026, 9, 9, 8, 0));

    const one = CommentPage.parse((await request(pristine.app).get(`${commentsPath(imageId)}?limit=0`)).body);
    expect(one.items.map((item) => item.id)).toEqual([extra.at(-1)]);

    const capped = CommentPage.parse((await request(pristine.app).get(`${commentsPath(imageId)}?limit=999`)).body);
    expect(capped.items).toHaveLength(50);
    expect(capped.nextCursor).toEqual(expect.any(String));

    const empty = CommentPage.parse((await request(pristine.app).get(`${commentsPath(imageId)}?limit=&cursor=`)).body);
    expect(empty.items).toHaveLength(20);
  });
});

describe('POST /api/images/:imageId/comments', () => {
  it('F-28 / F-32: creates the comment as the session: 201 CommentDto with canDelete, no Location', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, imageId, { authorName: 'Kofi', body: 'Where does it go?' });

    expect(response.status).toBe(201);
    expect(response.headers['location']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body as object).sort()).toEqual(DTO_KEYS);
    const dto = CommentDto.parse(response.body);
    expect(dto).toMatchObject({ imageId, authorName: 'Kofi', body: 'Where does it go?', canDelete: true });
    expect(JSON.stringify(response.body)).not.toMatch(/owner/i);

    // It is now the newest comment: deletable for its author, not for anyone else.
    const asAuthor = CommentPage.parse((await session.agent.get(commentsPath(imageId))).body);
    expect(asAuthor.items[0]).toEqual(dto);
    const asVisitor = CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body);
    expect(asVisitor.items[0]).toEqual({ ...dto, canDelete: false });
  });

  it('F-34: the first comment gives the provisional session its full lifetime in the same response', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, imageId, { authorName: 'Noor', body: 'Lovely textures.' });

    expect(response.status).toBe(201);
    const lifetime = sessionCookieLifetime(response);
    expect(lifetime).toBeGreaterThanOrEqual(180 * DAY_SECONDS - 1);
    expect(lifetime).toBeLessThanOrEqual(180 * DAY_SECONDS + 1);
  });

  it('F-29: stores trimmed, NFC-normalised values with LF line breaks; the limits are inclusive', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, imageId, {
      authorName: `  Jonas from Leipzig  `,
      body: `  Fish sandwich\r\nafterwards, I hope.  `,
    });
    // 1000 code points, one of them outside the BMP (two UTF-16 units): counted like Postgres char_length.
    const atLimit = await postComment(session, imageId, { authorName: 'n'.repeat(60), body: `${'x'.repeat(999)}🙂` });
    // "e" + combining acute (2 code points each before NFC, 1 after): normalised first, then counted.
    const decomposed = await postComment(session, imageId, {
      authorName: 'Lucía',
      body: 'é'.repeat(1000),
    });

    expect(response.status).toBe(201);
    expect(CommentDto.parse(response.body)).toMatchObject({
      authorName: 'Jonas from Leipzig',
      body: 'Fish sandwich\nafterwards, I hope.',
    });
    expect(atLimit.status).toBe(201);
    expect(decomposed.status).toBe(201);
    expect(CommentDto.parse(decomposed.body)).toMatchObject({
      authorName: 'Lucía',
      body: 'é'.repeat(1000),
    });
  });

  it('F-29 / B-26: empty, blank, too long and multi-line values are 400 with every field error at once', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const missing = await postComment(session, imageId, {});
    expect(missing.status).toBe(400);
    expect(problemOf(missing)).toMatchObject({
      code: 'validation-failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'authorName', location: 'body' }),
        expect.objectContaining({ field: 'body', location: 'body' }),
      ]) as unknown,
    });

    const blank = await postComment(session, imageId, { authorName: '   ', body: ' \n\t ' });
    expect(blank.status).toBe(400);
    expect(problemOf(blank).errors).toEqual([
      { field: 'authorName', location: 'body', message: fieldMessages.authorName.required },
      { field: 'body', location: 'body', message: fieldMessages.commentBody.required },
    ]);

    const tooLong = await postComment(session, imageId, { authorName: 'n'.repeat(61), body: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400);
    expect(problemOf(tooLong).errors).toEqual([
      { field: 'authorName', location: 'body', message: fieldMessages.authorName.tooLong },
      { field: 'body', location: 'body', message: fieldMessages.commentBody.tooLong },
    ]);

    const multiLineName = await postComment(session, imageId, { authorName: 'Kofi\nAgain', body: 'Hi' });
    expect(multiLineName.status).toBe(400);
    expect(problemOf(multiLineName).errors).toEqual([
      { field: 'authorName', location: 'body', message: fieldMessages.authorName.invalid },
    ]);

    // Nothing was stored by any of the rejected requests.
    expect(CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body).items).toEqual([]);
  });

  it('F-49: unknown keys are rejected (strict body)', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, imageId, { authorName: 'Kofi', body: 'Hi', ownerId: 'mine' });

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([
      { field: 'ownerId', location: 'body', message: requestMessages.unknownField },
    ]);
  });

  it('F-49: a non-JSON body is 415, a body over 16 KB is 413, broken JSON is 400 malformed-request', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);
    const post = () => session.agent.post(commentsPath(imageId)).set('x-csrf-token', session.csrfToken);

    const form = await post().type('form').send('authorName=Kofi&body=Hi');
    expect(form.status).toBe(415);
    expect(problemOf(form).code).toBe('unsupported-content-type');

    const huge = await post().send({ authorName: 'Kofi', body: 'x'.repeat(17 * 1024) });
    expect(huge.status).toBe(413);
    expect(problemOf(huge).code).toBe('payload-too-large');

    const broken = await post().type('json').send('{"authorName": "Kofi",');
    expect(broken.status).toBe(400);
    expect(problemOf(broken).code).toBe('malformed-request');
    expectSafeProblem(broken);
  });

  it('B-26: commenting on an unknown image is 404 not-found, not a database error', async () => {
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, 2_147_483_647, { authorName: 'Kofi', body: 'Hello?' });

    expect(response.status).toBe(404);
    expect(problemOf(response)).toMatchObject({ code: 'not-found', detail: 'Image was not found.' });
    expectSafeProblem(response);
  });

  it('B-26: commenting on an image deleted meanwhile is 404 (FK 23503 mapped)', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);
    await deleteImage(testApp.db, imageId);

    const response = await postComment(session, imageId, { authorName: 'Kofi', body: 'Too late.' });

    expect(response.status).toBe(404);
    expect(problemOf(response).code).toBe('not-found');
  });

  it('F-44: an invalid image id is 400 on the param, reported together with body errors', async () => {
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, 'abc', { authorName: '', body: 'Hi' });

    expect(response.status).toBe(400);
    expect(problemOf(response).errors).toEqual([
      { field: 'imageId', location: 'params', message: requestMessages.invalidId },
      { field: 'authorName', location: 'body', message: fieldMessages.authorName.required },
    ]);
  });

  it('F-39 / B-03: without a CSRF token (or without any session) the request is 403 csrf-invalid', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const noToken = await session.agent.post(commentsPath(imageId)).send({ authorName: 'Kofi', body: 'Hi' });
    const noSession = await request(testApp.app).post(commentsPath(imageId)).send({ authorName: 'Kofi', body: 'Hi' });

    for (const response of [noToken, noSession]) {
      expect(response.status).toBe(403);
      expect(problemOf(response).code).toBe('csrf-invalid');
    }
    expect(CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body).items).toEqual([]);
  });

  it('B-03: a cross-site request is 403 cross-origin-request even with a valid token', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);

    const response = await postComment(session, imageId, { authorName: 'Kofi', body: 'Hi' }).set(
      'Sec-Fetch-Site',
      'cross-site',
    );

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('cross-origin-request');
  });
});

describe('DELETE /api/comments/:id', () => {
  it('F-32: the session that wrote the comment deletes it (204) and it is gone from the list', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);
    const created = CommentDto.parse((await postComment(session, imageId, { authorName: 'Bea', body: 'Mine.' })).body);

    const response = await deleteComment(session, created.id);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body).items).toEqual([]);
    const again = await deleteComment(session, created.id);
    expect(again.status).toBe(404);
  });

  it('F-32 / B-02: another session gets 403 not-owner and the comment stays', async () => {
    const imageId = await insertImage(testApp.db);
    const author = await agentWithSession(testApp.app);
    const stranger = await agentWithSession(testApp.app);
    const created = CommentDto.parse((await postComment(author, imageId, { authorName: 'Bea', body: 'Mine.' })).body);

    const response = await deleteComment(stranger, created.id);

    expect(response.status).toBe(403);
    expect(problemOf(response)).toMatchObject({ code: 'not-owner', detail: notOwnerMessages.comment });
    expect(CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body).items).toHaveLength(1);
  });

  it('an unknown comment is 404 not-found', async () => {
    const session = await agentWithSession(testApp.app);

    const response = await deleteComment(session, 2_147_483_647);

    expect(response.status).toBe(404);
    expect(problemOf(response)).toMatchObject({ code: 'not-found', detail: 'Comment was not found.' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('F-44: an invalid id is 400 validation-failed on the id param', async () => {
    const session = await agentWithSession(testApp.app);

    for (const id of INVALID_IDS) {
      const response = await deleteComment(session, id);

      expect(response.status, id).toBe(400);
      expect(problemOf(response).errors).toEqual([
        { field: 'id', location: 'params', message: requestMessages.invalidId },
      ]);
    }
  });

  it('F-39 / B-03: without a CSRF token the delete is 403 csrf-invalid and the comment stays', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);
    const created = CommentDto.parse((await postComment(session, imageId, { authorName: 'Bea', body: 'Mine.' })).body);

    const response = await session.agent.delete(`/api/comments/${String(created.id)}`);

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('csrf-invalid');
    expect(CommentPage.parse((await request(testApp.app).get(commentsPath(imageId))).body).items).toHaveLength(1);
  });

  it('B-03: a cross-site delete is 403 cross-origin-request', async () => {
    const imageId = await insertImage(testApp.db);
    const session = await agentWithSession(testApp.app);
    const created = CommentDto.parse((await postComment(session, imageId, { authorName: 'Bea', body: 'Mine.' })).body);

    const response = await deleteComment(session, created.id).set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('cross-origin-request');
  });
});

describe('comment rate limits (ADR 0013)', () => {
  let limited: TestApp;

  beforeAll(async () => {
    limited = await createTestApp({ env: { RATE_LIMIT_COMMENTS: '2', RATE_LIMIT_DELETES: '1' } });
  });

  afterAll(async () => {
    await limited.close();
  });

  it('F-40: POST uses the comments budget and DELETE the deletes budget; reads are not affected', async () => {
    const imageId = await insertImage(limited.db);
    const session = await agentWithSession(limited.app);
    const first = CommentDto.parse((await postComment(session, imageId, { authorName: 'Bea', body: 'One.' })).body);
    expect((await postComment(session, imageId, { authorName: 'Bea', body: 'Two.' })).status).toBe(201);

    const third = await postComment(session, imageId, { authorName: 'Bea', body: 'Three.' });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
    expect(problemOf(third).code).toBe('rate-limited');

    expect((await deleteComment(session, first.id)).status).toBe(204);
    expect((await deleteComment(session, first.id)).status).toBe(429);

    expect((await session.agent.get(commentsPath(imageId))).status).toBe(200);
  });
});
