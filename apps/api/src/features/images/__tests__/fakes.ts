import { randomUUID } from 'node:crypto';

import type { ImageMimeType } from '@app/shared';

import type { ImageUploadPort, IncomingFile, IngestOptions, StoredImage } from '../../../shared/ports/image-upload.js';
import type { ImageRecord, ImagesRepository, NewImage } from '../images.repository.js';

/*
 * In-memory doubles for the images feature (ADR 0017): a repository with the same keyset semantics as the Drizzle
 * one, and a fake `ImageUploadPort`. The route tests use the fake port while the router still runs the real
 * multipart parser, so multipart behaviour is never re-implemented here.
 */

const EXTENSIONS: Readonly<Record<ImageMimeType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const FAKE_MEDIA_BASE = '/api/media';

/** Mutable per test (reset in `beforeEach`): what the next `ingest` and `discard` calls do. */
export interface FakeUploadBehaviour {
  /** Thrown by `ingest` instead of storing anything (415, 400 or an outage). */
  ingestError: Error | undefined;
  /** Rejected by `discard`, although the real port never rejects: proves the service still answers. */
  discardError: Error | undefined;
  /** Detected type of the stored image. */
  mimeType: ImageMimeType;
  /** Overrides the generated stored image, e.g. a key whose extension contradicts the MIME type. */
  stored: Partial<StoredImage> | undefined;
}

export interface FakeUploadPort extends ImageUploadPort {
  readonly behaviour: FakeUploadBehaviour;
  /** Every `ingest` call with exactly what it received (bytes and size, never a filename). */
  readonly ingested: { file: IncomingFile; options: IngestOptions | undefined }[];
  /** Object keys passed to `discard`, in call order. */
  readonly discarded: string[];
  /** Object keys "stored" by successful `ingest` calls and not discarded since. */
  storedKeys(): string[];
  reset(): void;
}

function defaultBehaviour(): FakeUploadBehaviour {
  return { ingestError: undefined, discardError: undefined, mimeType: 'image/png', stored: undefined };
}

/** `images/<uuid>.<ext>` → `previews/<uuid>.webp` (ADR 0018), as the upload module's port derives it. */
export function fakePreviewKey(objectKey: string): string {
  return objectKey.replace(/^images\//, 'previews/').replace(/\.[a-z]+$/, '.webp');
}

export function createFakeUploadPort(): FakeUploadPort {
  const behaviour = defaultBehaviour();
  const ingested: FakeUploadPort['ingested'] = [];
  const discarded: string[] = [];
  const stored = new Set<string>();

  return {
    behaviour,
    ingested,
    discarded,
    ingest(file, options) {
      ingested.push({ file, options });
      if (behaviour.ingestError) return Promise.reject(behaviour.ingestError);
      const image: StoredImage = {
        objectKey: `images/${randomUUID()}.${EXTENSIONS[behaviour.mimeType]}`,
        mimeType: behaviour.mimeType,
        width: 640,
        height: 480,
        sizeBytes: file.size,
        ...behaviour.stored,
      };
      stored.add(image.objectKey);
      return Promise.resolve(image);
    },
    discard(objectKey) {
      discarded.push(objectKey);
      if (behaviour.discardError) return Promise.reject(behaviour.discardError);
      stored.delete(objectKey);
      return Promise.resolve();
    },
    publicUrl: (objectKey) => `${FAKE_MEDIA_BASE}/${objectKey}`,
    previewUrl: (objectKey) => `${FAKE_MEDIA_BASE}/${fakePreviewKey(objectKey)}`,
    storedKeys: () => [...stored].sort(),
    reset() {
      Object.assign(behaviour, defaultBehaviour());
      ingested.length = 0;
      discarded.length = 0;
      stored.clear();
    },
  };
}

interface StoredRow extends ImageRecord {
  sizeBytes: number;
}

/** One call of the fake repository, for asserting the order of operations. */
export type RepositoryCall = 'list' | 'findById' | 'exists' | 'insert' | 'deleteOwned' | 'deleteById';

export interface FakeImagesRepository extends ImagesRepository {
  readonly calls: RepositoryCall[];
  /** Thrown by the next `insert` calls (e.g. a database outage), until set back to undefined. */
  insertError: Error | undefined;
  /** Adds a row directly, like a seed; `createdAt` defaults to the fake clock. */
  add(row?: Partial<NewImage> & { createdAt?: Date }): ImageRecord;
  rows(): StoredRow[];
}

const byNewestFirst = (a: ImageRecord, b: ImageRecord): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;

const isOlderThan = (row: ImageRecord, after: { createdAt: Date; id: number }): boolean =>
  row.createdAt.getTime() < after.createdAt.getTime() ||
  (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id);

/** The record the real repository returns: the stored row without `sizeBytes` (explicit columns, B-28). */
function toRecord({ sizeBytes: _sizeBytes, ...record }: StoredRow): ImageRecord {
  return { ...record, createdAt: new Date(record.createdAt) };
}

/**
 * In-memory `ImagesRepository`. Ids are sequential; the clock advances one millisecond per row, so insertion order is
 * newest-first order unless a test passes its own `createdAt`.
 */
export function createFakeImagesRepository(): FakeImagesRepository {
  const rows = new Map<number, StoredRow>();
  const calls: RepositoryCall[] = [];
  let nextId = 1;
  let clock = Date.parse('2026-11-01T10:00:00.000Z');

  const store = (image: NewImage, createdAt?: Date): StoredRow => {
    clock += 1;
    const row: StoredRow = { ...image, id: nextId, createdAt: createdAt ?? new Date(clock) };
    nextId += 1;
    rows.set(row.id, row);
    return row;
  };

  const repository: FakeImagesRepository = {
    calls,
    insertError: undefined,

    list({ limit, after }) {
      calls.push('list');
      const page = [...rows.values()]
        .filter((row) => after === undefined || isOlderThan(row, after))
        .sort(byNewestFirst)
        .slice(0, limit + 1);
      return Promise.resolve(page.map(toRecord));
    },
    findById(id) {
      calls.push('findById');
      const row = rows.get(id);
      return Promise.resolve(row ? toRecord(row) : undefined);
    },
    exists(id) {
      calls.push('exists');
      return Promise.resolve(rows.has(id));
    },
    insert(image) {
      calls.push('insert');
      if (repository.insertError) return Promise.reject(repository.insertError);
      return Promise.resolve(toRecord(store(image)));
    },
    deleteOwned(id, ownerId) {
      calls.push('deleteOwned');
      const row = rows.get(id);
      if (row?.ownerId !== ownerId) return Promise.resolve(undefined);
      rows.delete(id);
      return Promise.resolve(row.objectKey);
    },
    deleteById(id) {
      calls.push('deleteById');
      const row = rows.get(id);
      rows.delete(id);
      return Promise.resolve(row?.objectKey);
    },

    add({ createdAt, ...partial } = {}) {
      const id = nextId;
      const row = store(
        {
          objectKey: `images/${randomUUID()}.png`,
          mimeType: 'image/png',
          width: 640,
          height: 480,
          sizeBytes: 1234,
          authorName: 'Marit',
          title: `Image ${String(id)}`,
          description: '',
          ownerId: randomUUID(),
          ...partial,
        },
        createdAt,
      );
      return toRecord(row);
    },
    rows: () => [...rows.values()],
  };
  return repository;
}
