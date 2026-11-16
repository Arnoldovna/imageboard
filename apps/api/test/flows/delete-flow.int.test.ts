import { CommentDto, ImageDto, notOwnerMessages } from '@app/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comments, images } from '../../src/db/schema/index.js';
import { createFakeStorage, type FakeStorage } from '../fakes.js';
import { jpegWithGps } from '../fixtures.js';
import { agentWithSession, problemOf, type SessionAgent } from '../http.js';
import { createTestApp, type TestApp } from '../test-app.js';

/*
 * DELETE /api/images/:id end to end (phase 2.4): images, comments and upload modules together on Postgres, Redis and
 * the fake object storage. One statement removes the row and (by cascade) its comments, then both objects go, and the
 * media route stops serving them (F-36, F-D2, B-07, B-22, ADR 0008).
 */

interface Uploaded {
  dto: ImageDto;
  originalKey: string;
  previewKey: string;
}

async function upload({ agent, csrfToken }: SessionAgent, title = 'Bridge in the fog'): Promise<Uploaded> {
  const response = await agent
    .post('/api/images')
    .set('x-csrf-token', csrfToken)
    .field('authorName', 'Pavel')
    .field('title', title)
    .attach('file', jpegWithGps(), { filename: 'bridge.jpg', contentType: 'image/jpeg' });
  if (response.status !== 201) throw new Error(`upload answered ${String(response.status)}`);
  const dto = ImageDto.parse(response.body);
  return {
    dto,
    originalKey: dto.url.replace(/^\/api\/media\//, ''),
    previewKey: dto.previewUrl.replace(/^\/api\/media\//, ''),
  };
}

async function comment({ agent, csrfToken }: SessionAgent, imageId: number, body: string): Promise<CommentDto> {
  const response = await agent
    .post(`/api/images/${String(imageId)}/comments`)
    .set('x-csrf-token', csrfToken)
    .send({ authorName: 'Anouk', body });
  if (response.status !== 201) throw new Error(`comment answered ${String(response.status)}`);
  return CommentDto.parse(response.body);
}

function remove({ agent, csrfToken }: SessionAgent, id: number) {
  return agent.delete(`/api/images/${String(id)}`).set('x-csrf-token', csrfToken);
}

async function commentRows(testApp: TestApp, imageId: number): Promise<number> {
  return (await testApp.db.select({ id: comments.id }).from(comments).where(eq(comments.imageId, imageId))).length;
}

async function imageRows(testApp: TestApp, imageId: number): Promise<number> {
  return (await testApp.db.select({ id: images.id }).from(images).where(eq(images.id, imageId))).length;
}

describe('delete flow: row, comments and both objects', () => {
  let storage: FakeStorage;
  let testApp: TestApp;
  let owner: SessionAgent;
  let visitor: SessionAgent;

  beforeAll(async () => {
    storage = createFakeStorage();
    testApp = await createTestApp({ storage });
    owner = await agentWithSession(testApp.app);
    visitor = await agentWithSession(testApp.app);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-36 / F-D2 / B-07 / B-22: the owner gets 204; image, comments, original and preview are gone', async () => {
    const { dto, originalKey, previewKey } = await upload(owner);
    await comment(owner, dto.id, 'First!');
    await comment(visitor, dto.id, 'Moody in the best way.');
    expect(await commentRows(testApp, dto.id)).toBe(2);
    expect((await request(testApp.app).get(dto.url)).status).toBe(200);

    const response = await remove(owner, dto.id);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    // B-22: awaited before the answer, so nothing is left to race with the client's next request.
    expect(await imageRows(testApp, dto.id)).toBe(0);
    expect(await commentRows(testApp, dto.id)).toBe(0);
    expect(storage.keys()).not.toContain(originalKey);
    expect(storage.keys()).not.toContain(previewKey);

    const image = await owner.agent.get(`/api/images/${String(dto.id)}`);
    const thread = await owner.agent.get(`/api/images/${String(dto.id)}/comments`);
    const original = await request(testApp.app).get(dto.url);
    const preview = await request(testApp.app).get(dto.previewUrl);
    expect(image.status).toBe(404);
    expect(problemOf(image).code).toBe('not-found');
    expect(thread.status).toBe(404);
    expect(original.status).toBe(404);
    expect(preview.status).toBe(404);
    expect(problemOf(original).code).toBe('not-found');
  });

  it('F-35 / B-02: another session gets 403 not-owner; row, comments and objects stay', async () => {
    const { dto, originalKey, previewKey } = await upload(owner);
    await comment(owner, dto.id, 'Mine.');

    const response = await remove(visitor, dto.id);

    expect(response.status).toBe(403);
    expect(problemOf(response)).toMatchObject({ code: 'not-owner', detail: notOwnerMessages.image });
    expect(await imageRows(testApp, dto.id)).toBe(1);
    expect(await commentRows(testApp, dto.id)).toBe(1);
    expect(storage.keys()).toEqual(expect.arrayContaining([originalKey, previewKey]));
    expect((await request(testApp.app).get(dto.url)).status).toBe(200);
  });

  it('F-39: without a CSRF token the delete is 403 and nothing is removed', async () => {
    const { dto, originalKey } = await upload(owner);

    const response = await owner.agent.delete(`/api/images/${String(dto.id)}`);

    expect(response.status).toBe(403);
    expect(problemOf(response).code).toBe('csrf-invalid');
    expect(await imageRows(testApp, dto.id)).toBe(1);
    expect(storage.keys()).toContain(originalKey);
  });

  it('F-36: a second delete of the same image is 404, and other images are untouched', async () => {
    const kept = await upload(owner, 'Kept');
    const { dto } = await upload(owner, 'Deleted twice');

    expect((await remove(owner, dto.id)).status).toBe(204);
    const again = await remove(owner, dto.id);

    expect(again.status).toBe(404);
    expect(problemOf(again).code).toBe('not-found');
    expect(storage.keys()).toEqual(expect.arrayContaining([kept.originalKey, kept.previewKey]));
    expect((await owner.agent.get(`/api/images/${String(kept.dto.id)}`)).status).toBe(200);
  });
});

describe('delete flow: object storage failing on delete (ADR 0008)', () => {
  let storage: FakeStorage;
  let testApp: TestApp;

  beforeAll(async () => {
    // Every delete attempt fails: 3 attempts per key with the real backoff (100 ms, 400 ms), then an orphan log.
    storage = createFakeStorage({ failDelete: Number.MAX_SAFE_INTEGER });
    testApp = await createTestApp({ storage });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-36 / B-07: the delete still answers 204 and the image is gone from the product; objects were retried', async () => {
    const owner = await agentWithSession(testApp.app);
    const { dto, originalKey, previewKey } = await upload(owner);

    const response = await remove(owner, dto.id);

    expect(response.status).toBe(204);
    expect(await imageRows(testApp, dto.id)).toBe(0);
    expect((await owner.agent.get(`/api/images/${String(dto.id)}`)).status).toBe(404);
    expect(storage.calls().delete).toBe(6);
    // The orphans are an ops concern (logged at error), never a client error.
    expect(storage.keys()).toEqual([originalKey, previewKey].sort());
  });
});
