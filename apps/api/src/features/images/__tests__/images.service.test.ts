import { randomUUID } from 'node:crypto';

import { ImageDto, notOwnerMessages } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ForbiddenError,
  InvalidCursorError,
  InvalidImageError,
  NotFoundError,
  NotOwnerError,
  UnsupportedImageTypeError,
} from '../../../shared/errors/app-error.js';
import { encodeCursor } from '../../../shared/pagination/cursor.js';
import type { Actor } from '../../../shared/session/actor.js';
import { createImagesService } from '../images.service.js';
import { createFakeImagesRepository, createFakeUploadPort, FAKE_MEDIA_BASE, fakePreviewKey } from './fakes.js';

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

const fields = { authorName: 'Marit', title: 'Iris on the axis', description: 'Mirrored down the middle.' };
const file = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), size: 4 };

function setup() {
  const repository = createFakeImagesRepository();
  const upload = createFakeUploadPort();
  const logger = { error: vi.fn(), warn: vi.fn() };
  const service = createImagesService({ repository, upload, logger });
  const owner: Actor = { ownerId: randomUUID() };
  const stranger: Actor = { ownerId: randomUUID() };
  const anonymous: Actor = { ownerId: null };
  return { repository, upload, logger, service, owner, stranger, anonymous };
}

describe('images service: list', () => {
  it('F-01: returns images newest first (created_at DESC, id DESC)', async () => {
    const { service, repository, anonymous } = setup();
    const sameTime = new Date('2026-10-01T12:00:00.000Z');
    const older = repository.add({ createdAt: new Date('2026-09-01T12:00:00.000Z') });
    const tieLow = repository.add({ createdAt: sameTime });
    const tieHigh = repository.add({ createdAt: sameTime });
    const newest = repository.add({ createdAt: new Date('2026-11-01T12:00:00.000Z') });

    const page = await service.list(anonymous, { limit: 10, cursor: undefined });

    expect(page.items.map((item) => item.id)).toEqual([newest.id, tieHigh.id, tieLow.id, older.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('F-02 / B-46: fetches limit + 1 and returns nextCursor only when an older image exists', async () => {
    const { service, repository, anonymous } = setup();
    for (let index = 0; index < 13; index += 1) repository.add();

    const first = await service.list(anonymous, { limit: 12, cursor: undefined });
    expect(first.items).toHaveLength(12);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.list(anonymous, { limit: 12, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(13);
  });

  it('B-46: exactly one page of images has no nextCursor', async () => {
    const { service, repository, anonymous } = setup();
    for (let index = 0; index < 12; index += 1) repository.add();

    expect((await service.list(anonymous, { limit: 12, cursor: undefined })).nextCursor).toBeNull();
  });

  it('B-46: an empty gallery is an empty page, not an error', async () => {
    const { service, anonymous } = setup();

    await expect(service.list(anonymous, { limit: 12, cursor: undefined })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('F-04: the next page continues strictly after the cursor position', async () => {
    const { service, repository, anonymous } = setup();
    const [a, b, c] = [repository.add(), repository.add(), repository.add()];
    const cursor = encodeCursor({ createdAt: b.createdAt, id: b.id });

    const page = await service.list(anonymous, { limit: 5, cursor });

    expect(page.items.map((item) => item.id)).toEqual([a.id]);
    expect(page.items.map((item) => item.id)).not.toContain(c.id);
  });

  it('B-13: a cursor that does not decode is 400 invalid-cursor before any query', async () => {
    const { service, repository, anonymous } = setup();

    await expect(service.list(anonymous, { limit: 12, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    expect(repository.calls).toEqual([]);
  });

  it('B-02: canDelete is true only for the owning session', async () => {
    const { service, repository, owner, stranger, anonymous } = setup();
    repository.add({ ownerId: owner.ownerId ?? '' });

    expect((await service.list(owner, { limit: 1, cursor: undefined })).items[0]?.canDelete).toBe(true);
    expect((await service.list(stranger, { limit: 1, cursor: undefined })).items[0]?.canDelete).toBe(false);
    expect((await service.list(anonymous, { limit: 1, cursor: undefined })).items[0]?.canDelete).toBe(false);
  });
});

describe('images service: get', () => {
  it('F-43 / B-28: maps a record to exactly the ImageDto keys, never ownerId, objectKey or sizeBytes', async () => {
    const { service, repository, owner } = setup();
    const record = repository.add({
      ownerId: owner.ownerId ?? '',
      authorName: 'Tomás R.',
      title: 'Tower at sunrise',
      description: 'New flat, no lift.',
      createdAt: new Date('2026-11-12T19:23:00.000Z'),
    });

    const dto = await service.get(owner, record.id);

    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
    expect(ImageDto.parse(dto)).toEqual(dto);
    expect(dto).toEqual({
      id: record.id,
      url: `${FAKE_MEDIA_BASE}/${record.objectKey}`,
      previewUrl: `${FAKE_MEDIA_BASE}/${fakePreviewKey(record.objectKey)}`,
      width: 640,
      height: 480,
      mimeType: 'image/png',
      authorName: 'Tomás R.',
      title: 'Tower at sunrise',
      description: 'New flat, no lift.',
      createdAt: '2026-11-12T19:23:00.000Z',
      canDelete: true,
    });
    expect(JSON.stringify(dto)).not.toContain(owner.ownerId);
  });

  it('F-13 / B-21: an unknown id is NotFoundError "Image was not found."', async () => {
    const { service, anonymous } = setup();

    const error = await service.get(anonymous, 999).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toHaveProperty('message', 'Image was not found.');
  });
});

describe('images service: create', () => {
  it('F-25: ingests the bytes, stores the row for the session and returns canDelete true', async () => {
    const { service, repository, upload, owner } = setup();

    const dto = await service.create(owner, fields, file);

    expect(upload.ingested).toEqual([{ file: { buffer: file.buffer, size: 4 }, options: undefined }]);
    const [row] = repository.rows();
    expect(row).toMatchObject({ ...fields, ownerId: owner.ownerId, sizeBytes: 4, mimeType: 'image/png' });
    expect(dto).toMatchObject({ id: row!.id, ...fields, canDelete: true, url: `${FAKE_MEDIA_BASE}/${row!.objectKey}` });
    expect(Object.keys(dto).sort()).toEqual(DTO_KEYS);
    expect(upload.discarded).toEqual([]);
  });

  it('B-02: a caller without an identity is 403 session-required and nothing is ingested', async () => {
    const { service, upload, repository, anonymous } = setup();

    const error = await service.create(anonymous, fields, file).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toHaveProperty('code', 'session-required');
    expect(upload.ingested).toEqual([]);
    expect(repository.calls).toEqual([]);
  });

  it.each([
    ['415 unsupported-image-type', new UnsupportedImageTypeError()],
    ['400 invalid-image', new InvalidImageError()],
  ])('B-25: an ingest failure (%s) is rethrown and nothing is inserted', async (_label, failure) => {
    const { service, upload, repository, owner } = setup();
    upload.behaviour.ingestError = failure;

    await expect(service.create(owner, fields, file)).rejects.toBe(failure);
    expect(repository.calls).toEqual([]);
    expect(upload.discarded).toEqual([]);
  });

  it('F-23 / B-25: an insert failure discards the stored objects, then rethrows the original error', async () => {
    const { service, upload, repository, owner } = setup();
    const outage = new Error('connection terminated');
    repository.insertError = outage;

    await expect(service.create(owner, fields, file)).rejects.toBe(outage);
    expect(upload.ingested).toHaveLength(1);
    expect(upload.discarded).toHaveLength(1);
    expect(upload.storedKeys()).toEqual([]);
    expect(repository.rows()).toEqual([]);
  });

  it('F-23: a failing compensation is logged and the insert error still reaches the client', async () => {
    const { service, upload, repository, logger, owner } = setup();
    const outage = new Error('connection terminated');
    repository.insertError = outage;
    upload.behaviour.discardError = new Error('storage down');

    await expect(service.create(owner, fields, file)).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey: upload.discarded[0] }),
      'discarding stored image objects failed',
    );
  });
});

describe('images service: remove', () => {
  it('F-35 / F-36: the owner deletes the row first, then the objects are discarded', async () => {
    const { service, repository, upload, owner } = setup();
    const record = repository.add({ ownerId: owner.ownerId ?? '' });
    const discardSeesRow: boolean[] = [];
    const discard = upload.discard.bind(upload);
    upload.discard = async (objectKey) => {
      discardSeesRow.push(repository.rows().some((row) => row.id === record.id));
      await discard(objectKey);
    };

    await service.remove(owner, record.id);

    expect(repository.rows()).toEqual([]);
    expect(repository.calls).toEqual(['deleteOwned']);
    expect(upload.discarded).toEqual([record.objectKey]);
    expect(discardSeesRow).toEqual([false]);
  });

  it('F-35 / B-02: another session is NotOwnerError and nothing is deleted', async () => {
    const { service, repository, upload, owner, stranger } = setup();
    const record = repository.add({ ownerId: owner.ownerId ?? '' });

    const error = await service.remove(stranger, record.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotOwnerError);
    expect(error).toHaveProperty('message', notOwnerMessages.image);
    expect(repository.rows()).toHaveLength(1);
    expect(upload.discarded).toEqual([]);
  });

  it('F-35: an unknown id is NotFoundError', async () => {
    const { service, upload, owner } = setup();

    await expect(service.remove(owner, 42)).rejects.toBeInstanceOf(NotFoundError);
    expect(upload.discarded).toEqual([]);
  });

  it('B-02: a caller without an identity is 403 session-required before any query', async () => {
    const { service, repository, anonymous } = setup();
    const record = repository.add();

    await expect(service.remove(anonymous, record.id)).rejects.toHaveProperty('code', 'session-required');
    expect(repository.calls).toEqual([]);
  });

  it('ADR 0008: a failed object cleanup is logged at error and the delete still succeeds', async () => {
    const { service, repository, upload, logger, owner } = setup();
    const record = repository.add({ ownerId: owner.ownerId ?? '' });
    upload.behaviour.discardError = new Error('storage down');

    await expect(service.remove(owner, record.id)).resolves.toBeUndefined();
    expect(repository.rows()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey: record.objectKey }),
      'discarding stored image objects failed',
    );
  });
});

describe('images service: exists and adminRemove', () => {
  it('exists reports whether the image row is there', async () => {
    const { service, repository } = setup();
    const record = repository.add();

    await expect(service.exists(record.id)).resolves.toBe(true);
    await expect(service.exists(record.id + 1)).resolves.toBe(false);
  });

  it('ADR 0019: adminRemove deletes regardless of owner, discards the objects and logs the takedown', async () => {
    const { service, repository, upload, logger } = setup();
    const record = repository.add();

    await expect(service.adminRemove(record.id)).resolves.toBe('removed');
    expect(repository.rows()).toEqual([]);
    expect(upload.discarded).toEqual([record.objectKey]);
    expect(logger.warn).toHaveBeenCalledWith(
      { imageId: record.id, objectKey: record.objectKey },
      'image removed by an administrator',
    );
  });

  it('ADR 0019: adminRemove of an unknown id is not-found and discards nothing', async () => {
    const { service, upload } = setup();

    await expect(service.adminRemove(7)).resolves.toBe('not-found');
    expect(upload.discarded).toEqual([]);
  });
});
