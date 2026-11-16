import { CommentDto, CommentPage, notOwnerMessages } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  AppError,
  ForbiddenError,
  InvalidCursorError,
  NotFoundError,
  NotOwnerError,
} from '../../../shared/errors/app-error.js';
import { encodeCursor } from '../../../shared/pagination/cursor.js';
import type { Actor } from '../../../shared/session/actor.js';
import { createCommentsService } from '../comments.service.js';
import { createFakeCommentsRepository, type FakeCommentsRepositoryOptions } from './fakes.js';

const IMAGE_ID = 6;
const OTHER_IMAGE_ID = 7;
const UNKNOWN_IMAGE_ID = 404;

const sanne: Actor = { ownerId: '7b1f7c2e-1d3a-4c55-9a0e-6f2b8c4d1e01' };
const kofi: Actor = { ownerId: '0c9e4d2a-5b6f-4e8d-8a1c-3d7f9b2e6a02' };
const anonymous: Actor = { ownerId: null };

const DTO_KEYS = ['authorName', 'body', 'canDelete', 'createdAt', 'id', 'imageId'];

function setup(options: FakeCommentsRepositoryOptions = {}) {
  const repository = createFakeCommentsRepository({ imageIds: [IMAGE_ID, OTHER_IMAGE_ID], ...options });
  const imageExists = vi.fn((id: number) => Promise.resolve(repository.hasImage(id)));
  const service = createCommentsService({ repository, imageExists });
  return { repository, imageExists, service };
}

/** Writes `count` comments as `actor`, oldest first; returns their DTOs in that order. */
async function post(service: ReturnType<typeof setup>['service'], count: number, actor = sanne, imageId = IMAGE_ID) {
  const created: CommentDto[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(await service.create(actor, imageId, { authorName: 'Sanne', body: `Comment ${String(index + 1)}` }));
  }
  return created;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

describe('comments service: create', () => {
  it('F-32: stores the comment under the session identity and answers with canDelete true', async () => {
    const { service, repository } = setup();

    const dto = await service.create(sanne, IMAGE_ID, { authorName: 'Kofi', body: 'Where does it go?' });

    expect(CommentDto.parse(dto)).toEqual({
      id: 1,
      imageId: IMAGE_ID,
      authorName: 'Kofi',
      body: 'Where does it go?',
      createdAt: '2026-11-01T12:00:01.000Z',
      canDelete: true,
    });
    expect(repository.rows()).toEqual([expect.objectContaining({ id: 1, ownerId: sanne.ownerId })]);
  });

  it('F-43: the DTO has exactly the contract keys and never the owner id', async () => {
    const { service } = setup();

    const dto = await service.create(sanne, IMAGE_ID, { authorName: 'Kofi', body: 'Noted for next year.' });

    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
    expect(JSON.stringify(dto)).not.toContain(sanne.ownerId ?? 'unreachable');
  });

  it('B-26: a comment on an unknown or deleted image is a 404, not a database error', async () => {
    const { service, repository } = setup();
    repository.removeImage(OTHER_IMAGE_ID);

    for (const imageId of [UNKNOWN_IMAGE_ID, OTHER_IMAGE_ID]) {
      const error = await rejection(service.create(sanne, imageId, { authorName: 'Kofi', body: 'Hello?' }));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.status).toBe(404);
      expect(error.message).toBe('Image was not found.');
    }
    expect(repository.rows()).toEqual([]);
  });

  it('refuses to write without an anonymous identity (403 session-required)', async () => {
    const { service, repository } = setup();

    const error = await rejection(service.create(anonymous, IMAGE_ID, { authorName: 'Kofi', body: 'Hi' }));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.code).toBe('session-required');
    expect(repository.rows()).toEqual([]);
  });
});

describe('comments service: list', () => {
  it('F-27 / B-41: newest first, ties on created_at broken by the higher id', async () => {
    const at = new Date('2026-10-06T15:52:00.000Z');
    const { service, repository } = setup();
    repository.seed({ id: 1, imageId: IMAGE_ID, authorName: 'Marit', body: 'oldest', ownerId: 'a', createdAt: at });
    repository.seed({
      id: 3,
      imageId: IMAGE_ID,
      authorName: 'Kofi',
      body: 'tie, higher id',
      ownerId: 'a',
      createdAt: new Date(at.getTime() + 1),
    });
    repository.seed({
      id: 2,
      imageId: IMAGE_ID,
      authorName: 'Bea',
      body: 'tie, lower id',
      ownerId: 'a',
      createdAt: new Date(at.getTime() + 1),
    });
    repository.seed({
      id: 4,
      imageId: IMAGE_ID,
      authorName: 'Pavel',
      body: 'newest',
      ownerId: 'a',
      createdAt: new Date(at.getTime() + 2),
    });

    const page = await service.list(sanne, IMAGE_ID, { limit: 20 });

    expect(page.items.map((item) => item.id)).toEqual([4, 3, 2, 1]);
    expect(page.nextCursor).toBeNull();
  });

  it('F-32: canDelete is true only for the session that wrote the comment', async () => {
    const { service } = setup();
    await post(service, 1, sanne);
    await post(service, 1, kofi);

    const asSanne = await service.list(sanne, IMAGE_ID, { limit: 20 });
    const asKofi = await service.list(kofi, IMAGE_ID, { limit: 20 });
    const asAnonymous = await service.list(anonymous, IMAGE_ID, { limit: 20 });

    expect(asSanne.items.map((item) => item.canDelete)).toEqual([false, true]);
    expect(asKofi.items.map((item) => item.canDelete)).toEqual([true, false]);
    expect(asAnonymous.items.map((item) => item.canDelete)).toEqual([false, false]);
    for (const item of asSanne.items) expect(Object.keys(item).sort()).toEqual(DTO_KEYS);
  });

  it('F-31 / B-45: keyset pages cover every comment exactly once, with nextCursor only while older ones exist', async () => {
    const { service } = setup();
    const created = await post(service, 25);

    const first = CommentPage.parse(await service.list(sanne, IMAGE_ID, { limit: 20 }));
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = CommentPage.parse(
      await service.list(sanne, IMAGE_ID, { limit: 20, cursor: first.nextCursor ?? '' }),
    );
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(seen).toEqual(created.map((item) => item.id).reverse());
  });

  it('B-46: exactly `limit` comments give no nextCursor', async () => {
    const { service } = setup();
    await post(service, 20);

    const page = await service.list(sanne, IMAGE_ID, { limit: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeNull();
  });

  it('F-04: a comment written between two page requests is neither repeated nor skipped', async () => {
    const { service } = setup();
    const created = await post(service, 5);
    const first = await service.list(sanne, IMAGE_ID, { limit: 2 });

    await post(service, 1);
    const rest = await service.list(sanne, IMAGE_ID, { limit: 10, cursor: first.nextCursor ?? '' });

    expect([...first.items, ...rest.items].map((item) => item.id)).toEqual(created.map((item) => item.id).reverse());
  });

  it('lists only the comments of the requested image', async () => {
    const { service } = setup();
    await post(service, 2, sanne, IMAGE_ID);
    await post(service, 3, sanne, OTHER_IMAGE_ID);

    const page = await service.list(sanne, OTHER_IMAGE_ID, { limit: 20 });

    expect(page.items).toHaveLength(3);
    expect(page.items.every((item) => item.imageId === OTHER_IMAGE_ID)).toBe(true);
  });

  it('B-26: an empty first page of an unknown image is a 404', async () => {
    const { service, imageExists } = setup();

    const error = await rejection(service.list(sanne, UNKNOWN_IMAGE_ID, { limit: 20 }));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe('Image was not found.');
    expect(imageExists).toHaveBeenCalledExactlyOnceWith(UNKNOWN_IMAGE_ID);
  });

  it('F-30: an existing image without comments is an empty page, not a 404', async () => {
    const { service, imageExists } = setup();

    await expect(service.list(sanne, IMAGE_ID, { limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(imageExists).toHaveBeenCalledExactlyOnceWith(IMAGE_ID);
  });

  it('checks the image only when the first page is empty (a filled page needs no extra query)', async () => {
    const { service, imageExists } = setup();
    await post(service, 3);

    const first = await service.list(sanne, IMAGE_ID, { limit: 2 });
    await service.list(sanne, IMAGE_ID, { limit: 2, cursor: first.nextCursor ?? '' });
    // A later page that is empty (cursor older than every comment) is not the "first page is empty" case.
    const past = encodeCursor({ createdAt: new Date('2000-01-01T00:00:00.000Z'), id: 1 });
    await expect(service.list(sanne, IMAGE_ID, { limit: 2, cursor: past })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });

    expect(imageExists).not.toHaveBeenCalled();
  });

  it('F-44: a cursor that does not decode is 400 invalid-cursor, before any query', async () => {
    const repository = createFakeCommentsRepository({ imageIds: [IMAGE_ID] });
    const listForImage = vi.spyOn(repository, 'listForImage');
    const imageExists = vi.fn(() => Promise.resolve(true));
    const service = createCommentsService({ repository, imageExists });

    for (const cursor of ['not base64!', Buffer.from('{"t":"yesterday","id":1}').toString('base64url')]) {
      const error = await rejection(service.list(sanne, IMAGE_ID, { limit: 20, cursor }));
      expect(error).toBeInstanceOf(InvalidCursorError);
      expect(error.code).toBe('invalid-cursor');
    }
    expect(listForImage).not.toHaveBeenCalled();
    expect(imageExists).not.toHaveBeenCalled();
  });
});

describe('comments service: remove', () => {
  it('F-32: the session that wrote a comment deletes it', async () => {
    const { service, repository } = setup();
    const [mine, other] = [...(await post(service, 1, sanne)), ...(await post(service, 1, kofi))];

    await service.remove(sanne, mine!.id);

    expect(repository.rows().map((row) => row.id)).toEqual([other!.id]);
  });

  it('F-32 / B-02: any other session gets 403 not-owner and the comment stays', async () => {
    const { service, repository } = setup();
    const [comment] = await post(service, 1, sanne);

    const error = await rejection(service.remove(kofi, comment!.id));

    expect(error).toBeInstanceOf(NotOwnerError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('not-owner');
    expect(error.message).toBe(notOwnerMessages.comment);
    expect(repository.rows()).toHaveLength(1);
  });

  it('an unknown or already deleted comment is 404 not-found', async () => {
    const { service } = setup();
    const [comment] = await post(service, 1, sanne);
    await service.remove(sanne, comment!.id);

    for (const id of [comment!.id, 999]) {
      const error = await rejection(service.remove(sanne, id));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe('Comment was not found.');
    }
  });

  it('refuses to delete without an anonymous identity (403 session-required)', async () => {
    const { service, repository } = setup();
    const [comment] = await post(service, 1, sanne);

    const error = await rejection(service.remove(anonymous, comment!.id));

    expect(error.code).toBe('session-required');
    expect(repository.rows()).toHaveLength(1);
  });
});
