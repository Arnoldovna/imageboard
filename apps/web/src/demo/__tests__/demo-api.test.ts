// @vitest-environment node
// Node's own fetch classes (Request, FormData, File): the handlers run exactly as MSW calls them in the browser.
import {
  CommentDto,
  CommentPage,
  fileMessages,
  ImageDto,
  ImagePage,
  notOwnerMessages,
  ProblemDetails,
  requestMessages,
  SessionDto,
  uploadTooLarge,
} from '@app/shared';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../demo-api';
import { CSRF_TOKEN, demoHarness, json, NOW, pngFile, PNG_BYTES, uploadForm } from './demo-fixtures';

async function problemOf(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  return ProblemDetails.parse(await response.json());
}

const validFields = { authorName: 'Kofi', title: 'Harbour at dusk', description: 'Line one\r\nline two' };

describe('demo API: session', () => {
  it('answers GET /api/session with the CSRF token and the 5 MB upload limit', async () => {
    const { call } = await demoHarness();

    const response = await call('GET', '/api/session');

    expect(response.status).toBe(200);
    expect(SessionDto.parse(await response.json())).toEqual({ csrfToken: CSRF_TOKEN, uploadMaxBytes: 5 * 1024 * 1024 });
  });
});

describe('demo API: gallery', () => {
  it('lists the seed newest first, with ids in upload order and nothing deletable', async () => {
    const { call } = await demoHarness();

    const page = ImagePage.parse(await (await call('GET', '/api/images')).json());

    expect(page.items.map((image) => [image.id, image.title, image.canDelete])).toEqual([
      [3, 'Second coffee, first idea', false],
      [2, 'Last train already gone', false],
      [1, 'Fog over the pines', false],
    ]);
    expect(page.items[0]?.previewUrl).toBe('/imageboard/assets/second-coffee.jpg');
    expect(page.nextCursor).toBeNull();
  });

  it('pages with keyset cursors until nextCursor is null', async () => {
    const { call } = await demoHarness();

    const first = ImagePage.parse(await (await call('GET', '/api/images?limit=2')).json());
    const second = ImagePage.parse(
      await (await call('GET', `/api/images?limit=2&cursor=${first.nextCursor ?? ''}`)).json(),
    );

    expect(first.items.map((image) => image.id)).toEqual([3, 2]);
    expect(second.items.map((image) => image.id)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });

  it('clamps an out-of-range limit like the API (F-02)', async () => {
    const { call } = await demoHarness();

    const page = ImagePage.parse(await (await call('GET', '/api/images?limit=0')).json());

    expect(page.items).toHaveLength(1);
  });

  it.each([
    ['limit=abc', 'limit', requestMessages.invalidLimit],
    ['sort=new', 'sort', requestMessages.unknownField],
    [`cursor=${'a'.repeat(201)}`, 'cursor', requestMessages.invalidCursor],
  ])('rejects the query %s with 400 validation-failed on its field', async (query, field, message) => {
    const { call } = await demoHarness();

    const response = await call('GET', `/api/images?${query}`);

    expect(response.status).toBe(400);
    const problem = await problemOf(response);
    expect(problem.code).toBe('validation-failed');
    expect(problem.errors).toEqual([{ field, location: 'query', message }]);
  });

  it('rejects a cursor that does not decode with 400 invalid-cursor', async () => {
    const { call } = await demoHarness();

    for (const cursor of ['not*base64', encodeURIComponent(btoa('{"t":"yesterday","id":1}')), btoa('[]')]) {
      const response = await call('GET', `/api/images?cursor=${cursor}`);
      expect(response.status).toBe(400);
      expect((await problemOf(response)).code).toBe('invalid-cursor');
    }
  });

  it('round-trips its own cursors', () => {
    const position = { createdAt: '2026-09-21T06:42:00.000Z', id: 7 };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(encodeCursor(position)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns one image, 404 for an unknown id and 400 for an id that is not canonical (F-44)', async () => {
    const { call } = await demoHarness();

    expect(ImageDto.parse(await (await call('GET', '/api/images/2')).json()).title).toBe('Last train already gone');

    const missing = await call('GET', '/api/images/99');
    expect(missing.status).toBe(404);
    expect((await problemOf(missing)).detail).toBe('Image was not found.');

    const invalid = await call('GET', '/api/images/01');
    expect(invalid.status).toBe(400);
    expect((await problemOf(invalid)).errors).toEqual([
      { field: 'id', location: 'params', message: requestMessages.invalidId },
    ]);
  });
});

describe('demo API: upload', () => {
  it('stores the upload in the browser and lists it first, deletable, from a blob: URL', async () => {
    const { call, mutate, objectUrls } = await demoHarness();

    const response = await mutate('POST', '/api/images', { body: uploadForm(validFields, pngFile()) });

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/api/images/4');
    const created = ImageDto.parse(await response.json());
    expect(created).toMatchObject({
      id: 4,
      mimeType: 'image/png',
      width: 640,
      height: 480,
      authorName: 'Kofi',
      title: 'Harbour at dusk',
      description: 'Line one\nline two',
      createdAt: NOW,
      canDelete: true,
    });
    expect(created.url).toMatch(/^blob:/);
    expect(created.previewUrl).toBe(created.url);
    const stored = objectUrls.create.mock.calls[0]?.[0];
    expect(stored?.type).toBe('image/png');
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG_BYTES);

    const page = ImagePage.parse(await (await call('GET', '/api/images')).json());
    expect(page.items[0]).toEqual(created);
    // One object URL per image, reused across requests.
    expect(objectUrls.create).toHaveBeenCalledTimes(1);
  });

  it('never shows a cached blob: URL for a different upload that reuses the id after a reset in another tab', async () => {
    const tabA = await demoHarness();
    await tabA.mutate('POST', '/api/images', { body: uploadForm(validFields, pngFile()) });
    const before = ImagePage.parse(await (await tabA.call('GET', '/api/images')).json()).items[0];

    // Tab B shares the browser's IndexedDB: it resets and uploads again, which gets the same id 4.
    const tabB = await demoHarness({ factory: tabA.factory, now: () => new Date('2026-11-18T11:00:00.000Z') });
    await tabB.store.reset();
    await tabB.mutate('POST', '/api/images', { body: uploadForm({ ...validFields, title: 'Other photo' }, pngFile()) });

    const after = ImagePage.parse(await (await tabA.call('GET', '/api/images')).json()).items[0];
    expect(after?.id).toBe(before?.id);
    expect(after?.title).toBe('Other photo');
    expect(after?.url).not.toBe(before?.url);
    expect(tabA.objectUrls.create).toHaveBeenCalledTimes(2);
  });

  it('refuses a mutation without the session CSRF token (403 csrf-invalid)', async () => {
    const { call } = await demoHarness();

    for (const headers of [{}, { 'x-csrf-token': 'stale' }] as Record<string, string>[]) {
      const response = await call('POST', '/api/images', { body: uploadForm(validFields, pngFile()), headers });
      expect(response.status).toBe(403);
      expect((await problemOf(response)).code).toBe('csrf-invalid');
    }
  });

  it('reports every field issue and the missing file at once (400 validation-failed)', async () => {
    const { mutate } = await demoHarness();

    const response = await mutate('POST', '/api/images', {
      body: uploadForm({ authorName: '  ', title: 'Two\nlines', colour: 'red' }),
    });

    expect(response.status).toBe(400);
    const problem = await problemOf(response);
    expect(problem.code).toBe('validation-failed');
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        { field: 'authorName', location: 'body', message: 'Enter a name.' },
        { field: 'title', location: 'body', message: 'Title must be on one line.' },
        { field: 'colour', location: 'body', message: requestMessages.unknownField },
        { field: 'file', location: 'file', message: fileMessages.required },
      ]),
    );
    expect(problem.errors).toHaveLength(4);
  });

  it('checks the file by its content, size and decodability, like the API', async () => {
    const tooLarge = await demoHarness({ uploadMaxBytes: 4 });
    const big = await tooLarge.mutate('POST', '/api/images', { body: uploadForm(validFields, pngFile()) });
    expect(big.status).toBe(413);
    expect((await problemOf(big)).detail).toBe(uploadTooLarge(4));

    const { mutate } = await demoHarness();
    const text = new File(['plain text'], 'photo.png', { type: 'image/png' });
    const unsupported = await mutate('POST', '/api/images', { body: uploadForm(validFields, text) });
    expect(unsupported.status).toBe(415);
    expect((await problemOf(unsupported)).code).toBe('unsupported-image-type');

    const undecodable = await demoHarness({ readImageSize: () => Promise.reject(new Error('decode failed')) });
    const broken = await undecodable.mutate('POST', '/api/images', { body: uploadForm(validFields, pngFile()) });
    expect(broken.status).toBe(400);
    expect(await problemOf(broken)).toMatchObject({ code: 'invalid-image', detail: fileMessages.unreadable });
  });

  it('refuses a second file part and a body that is not multipart', async () => {
    const { mutate } = await demoHarness();

    const form = uploadForm(validFields, pngFile());
    form.append('file', pngFile());
    const twoFiles = await mutate('POST', '/api/images', { body: form });
    expect(twoFiles.status).toBe(400);
    expect((await problemOf(twoFiles)).code).toBe('malformed-request');

    const asJson = await mutate('POST', '/api/images', json(validFields));
    expect(asJson.status).toBe(415);
    expect(await problemOf(asJson)).toMatchObject({
      code: 'unsupported-content-type',
      detail: requestMessages.multipartRequired,
    });
  });
});

describe('demo API: delete image', () => {
  it('deletes only the visitor’s own image, with its comments, and revokes its blob: URL', async () => {
    const { call, mutate, objectUrls, store } = await demoHarness();
    const created = ImageDto.parse(
      await (await mutate('POST', '/api/images', { body: uploadForm(validFields, pngFile()) })).json(),
    );
    await mutate('POST', `/api/images/${String(created.id)}/comments`, json({ authorName: 'Kofi', body: 'Mine.' }));

    const seed = await mutate('DELETE', '/api/images/1');
    expect(seed.status).toBe(403);
    expect(await problemOf(seed)).toMatchObject({ code: 'not-owner', detail: notOwnerMessages.image });

    const own = await mutate('DELETE', `/api/images/${String(created.id)}`);
    expect(own.status).toBe(204);
    expect((await call('GET', `/api/images/${String(created.id)}`)).status).toBe(404);
    expect(await store.comments(created.id)).toEqual([]);
    expect(await store.file(created.id)).toBeUndefined();
    expect(objectUrls.revoke).toHaveBeenCalledWith(created.url);

    expect((await mutate('DELETE', `/api/images/${String(created.id)}`)).status).toBe(404);
  });
});

describe('demo API: comments', () => {
  it('lists an image’s comments newest first and 404s for an unknown image', async () => {
    const { call } = await demoHarness();

    const page = CommentPage.parse(await (await call('GET', '/api/images/1/comments')).json());
    expect(page.items.map((comment) => [comment.authorName, comment.canDelete])).toEqual([
      ['Bea', false],
      ['Henrik', false],
    ]);
    expect(CommentPage.parse(await (await call('GET', '/api/images/2/comments')).json()).items).toEqual([]);
    expect((await call('GET', '/api/images/99/comments')).status).toBe(404);
  });

  it('adds a normalised comment and lets only its author delete it', async () => {
    const { call, mutate } = await demoHarness();

    const response = await mutate('POST', '/api/images/2/comments', json({ authorName: ' Noor ', body: 'Lovely\r\n' }));
    expect(response.status).toBe(201);
    const comment = CommentDto.parse(await response.json());
    expect(comment).toMatchObject({ imageId: 2, authorName: 'Noor', body: 'Lovely', createdAt: NOW, canDelete: true });

    const seedComment = await mutate('DELETE', '/api/comments/1');
    expect(seedComment.status).toBe(403);
    expect((await problemOf(seedComment)).detail).toBe(notOwnerMessages.comment);

    expect((await mutate('DELETE', `/api/comments/${String(comment.id)}`)).status).toBe(204);
    expect(CommentPage.parse(await (await call('GET', '/api/images/2/comments')).json()).items).toEqual([]);
    expect((await mutate('DELETE', `/api/comments/${String(comment.id)}`)).status).toBe(404);
  });

  it('validates the comment body like the API', async () => {
    const { mutate } = await demoHarness();

    const empty = await mutate('POST', '/api/images/1/comments', json({ authorName: 'Bea', body: '   ', extra: 1 }));
    expect(empty.status).toBe(400);
    expect((await problemOf(empty)).errors).toEqual(
      expect.arrayContaining([
        { field: 'body', location: 'body', message: 'Write a comment.' },
        { field: 'extra', location: 'body', message: requestMessages.unknownField },
      ]),
    );

    const notJson = await mutate('POST', '/api/images/1/comments', { body: 'authorName=Bea' });
    expect(notJson.status).toBe(415);

    const broken = await mutate('POST', '/api/images/1/comments', {
      body: '{"authorName":',
      headers: { 'content-type': 'application/json' },
    });
    expect((await problemOf(broken)).code).toBe('malformed-request');

    const tooLarge = await mutate(
      'POST',
      '/api/images/1/comments',
      json({ authorName: 'Bea', body: 'x'.repeat(17_000) }),
    );
    expect(tooLarge.status).toBe(413);
    expect((await problemOf(tooLarge)).detail).toBe(requestMessages.jsonBodyTooLarge);

    const unknownImage = await mutate('POST', '/api/images/99/comments', json({ authorName: 'Bea', body: 'Hi' }));
    expect(unknownImage.status).toBe(404);
  });
});

describe('demo API: unknown routes', () => {
  it('answers 404 problem+json, after the CSRF check for unsafe methods (API.md §6)', async () => {
    const { call, mutate } = await demoHarness();

    expect((await call('GET', '/api/nothing')).status).toBe(404);
    expect((await problemOf(await call('POST', '/api/nothing'))).code).toBe('csrf-invalid');
    expect((await problemOf(await mutate('POST', '/api/nothing'))).code).toBe('not-found');
  });
});
