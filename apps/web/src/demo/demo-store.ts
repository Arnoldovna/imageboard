import type { ImageMimeType } from '@app/shared';

/*
 * The demo's "database": IndexedDB in the visitor's browser (PLAN Etappe 3b). Nothing is ever sent anywhere. Rows
 * mirror the API's tables closely enough for the handlers to apply the same rules (ownership, keyset order, cascade).
 */

export interface DemoSeedComment {
  authorName: string;
  body: string;
  createdAt: string;
}

export interface DemoSeedImage {
  url: string;
  width: number;
  height: number;
  mimeType: ImageMimeType;
  authorName: string;
  title: string;
  description: string;
  createdAt: string;
  comments: readonly DemoSeedComment[];
}

export interface DemoSeed {
  /**
   * The API seed's owner (`SEED_OWNER_ID`), which no visitor ever is, so seed content cannot be deleted
   * (DATA-MODEL §6.1).
   */
  ownerId: string;
  /** Oldest first, as uploaded. */
  images: readonly DemoSeedImage[];
}

export interface ImageRecord {
  id: number;
  ownerId: string;
  /** The seed photo's asset URL; `null` for an upload, whose bytes are in the `files` store. */
  url: string | null;
  width: number;
  height: number;
  mimeType: ImageMimeType;
  authorName: string;
  title: string;
  description: string;
  createdAt: string;
}

export interface CommentRecord {
  id: number;
  imageId: number;
  ownerId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/** An uploaded image's bytes. Stored as an ArrayBuffer: structured-cloning `Blob`s into IndexedDB is less portable. */
export interface StoredFile {
  bytes: ArrayBuffer;
  type: ImageMimeType;
}

/** The visitor's identity (like the API's anonymous session owner id) and the next ids. */
export interface DemoState {
  ownerId: string;
  nextImageId: number;
  nextCommentId: number;
}

export type NewImage = Omit<ImageRecord, 'id'>;
export type NewComment = Omit<CommentRecord, 'id'>;

export interface DemoStore {
  state(): Promise<DemoState>;
  images(): Promise<ImageRecord[]>;
  image(id: number): Promise<ImageRecord | undefined>;
  /** Stores the row and, for an upload, its bytes in one transaction. */
  insertImage(image: NewImage, file?: StoredFile): Promise<ImageRecord>;
  /** Deletes the image, its file and all its comments in one transaction (the API's `ON DELETE CASCADE`). */
  deleteImage(id: number): Promise<void>;
  file(imageId: number): Promise<StoredFile | undefined>;
  comments(imageId: number): Promise<CommentRecord[]>;
  comment(id: number): Promise<CommentRecord | undefined>;
  insertComment(comment: NewComment): Promise<CommentRecord>;
  deleteComment(id: number): Promise<void>;
  /** Empties every store and writes the seed again, with a new owner id: the Reset button. */
  reset(): Promise<void>;
  close(): void;
}

/** `insertComment` on an image that no longer exists (deleted in another tab meanwhile). */
export class MissingImageError extends Error {
  override readonly name = 'MissingImageError';
}

export const DEMO_DB_NAME = 'imageboard-demo';
const DB_VERSION = 1;

const IMAGES = 'images';
const COMMENTS = 'comments';
const FILES = 'files';
const META = 'meta';
const ALL_STORES = [IMAGES, COMMENTS, FILES, META];
const STATE_KEY = 'state';
const BY_IMAGE = 'byImage';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/**
 * Runs `work` in one transaction and resolves after it committed. `work` must only await IndexedDB requests of `tx`
 * (any other await would let the transaction auto-commit early). A rejection aborts the transaction.
 */
async function inTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
  });
  try {
    const result = await work(tx);
    await committed;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // InvalidStateError: the transaction had already committed or aborted.
    }
    await committed.catch(() => undefined);
    throw error;
  }
}

function newerFirst<T extends { createdAt: string; id: number }>(a: T, b: T): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

async function readState(tx: IDBTransaction): Promise<DemoState> {
  const state = (await requestResult(tx.objectStore(META).get(STATE_KEY))) as DemoState | undefined;
  if (state === undefined) throw new Error('The demo database has not been seeded.');
  return state;
}

/** Clears every store and writes the seed: ids 1..n in upload order, like a fresh `pnpm db:seed`. */
async function writeSeed(tx: IDBTransaction, seed: DemoSeed, ownerId: string): Promise<void> {
  for (const name of ALL_STORES) await requestResult(tx.objectStore(name).clear());
  let nextImageId = 1;
  let nextCommentId = 1;
  for (const { comments, ...image } of seed.images) {
    const imageId = nextImageId++;
    const row: ImageRecord = { ...image, id: imageId, ownerId: seed.ownerId };
    await requestResult(tx.objectStore(IMAGES).add(row));
    for (const comment of comments) {
      const commentRow: CommentRecord = { ...comment, id: nextCommentId++, imageId, ownerId: seed.ownerId };
      await requestResult(tx.objectStore(COMMENTS).add(commentRow));
    }
  }
  const state: DemoState = { ownerId, nextImageId, nextCommentId };
  await requestResult(tx.objectStore(META).put(state, STATE_KEY));
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DEMO_DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(IMAGES, { keyPath: 'id' });
    db.createObjectStore(COMMENTS, { keyPath: 'id' }).createIndex(BY_IMAGE, 'imageId');
    db.createObjectStore(FILES);
    db.createObjectStore(META);
  };
  return requestResult(request);
}

export interface OpenDemoStoreOptions {
  seed: DemoSeed;
  /** Default: the browser's `indexedDB`. Tests pass a fresh `fake-indexeddb` factory. */
  factory?: IDBFactory;
  /** Default: `crypto.randomUUID`. */
  newOwnerId?: () => string;
  /**
   * Called after this connection was closed because another tab opened a newer schema version (a new deploy). Every
   * later request of this tab would fail, so the browser passes a page reload here.
   */
  onClosedByNewerVersion?: () => void;
}

/** Opens (and on first use seeds) the demo database. */
export async function openDemoStore({
  seed,
  factory = indexedDB,
  newOwnerId = () => crypto.randomUUID(),
  onClosedByNewerVersion,
}: OpenDemoStoreOptions): Promise<DemoStore> {
  const db = await openDatabase(factory);
  // Another tab upgrading the schema must not be blocked by this one; this tab then reloads into the new version.
  db.onversionchange = () => {
    db.close();
    onClosedByNewerVersion?.();
  };

  await inTransaction(db, ALL_STORES, 'readwrite', async (tx) => {
    const existing: unknown = await requestResult(tx.objectStore(META).get(STATE_KEY));
    if (existing === undefined) await writeSeed(tx, seed, newOwnerId());
  });

  const read = <T>(stores: readonly string[], work: (tx: IDBTransaction) => Promise<T>) =>
    inTransaction(db, stores, 'readonly', work);
  const write = <T>(stores: readonly string[], work: (tx: IDBTransaction) => Promise<T>) =>
    inTransaction(db, stores, 'readwrite', work);

  return {
    state: () => read([META], readState),
    images: () =>
      read([IMAGES], async (tx) => {
        const rows = (await requestResult(tx.objectStore(IMAGES).getAll())) as ImageRecord[];
        return rows.sort(newerFirst);
      }),
    image: (id) =>
      read([IMAGES], async (tx) => (await requestResult(tx.objectStore(IMAGES).get(id))) as ImageRecord | undefined),
    insertImage: (image, file) =>
      write([IMAGES, FILES, META], async (tx) => {
        const state = await readState(tx);
        const row: ImageRecord = { ...image, id: state.nextImageId };
        await requestResult(tx.objectStore(IMAGES).add(row));
        if (file !== undefined) await requestResult(tx.objectStore(FILES).add(file, row.id));
        await requestResult(tx.objectStore(META).put({ ...state, nextImageId: row.id + 1 }, STATE_KEY));
        return row;
      }),
    deleteImage: (id) =>
      write([IMAGES, COMMENTS, FILES], async (tx) => {
        const commentKeys = await requestResult(tx.objectStore(COMMENTS).index(BY_IMAGE).getAllKeys(id));
        for (const key of commentKeys) await requestResult(tx.objectStore(COMMENTS).delete(key));
        await requestResult(tx.objectStore(FILES).delete(id));
        await requestResult(tx.objectStore(IMAGES).delete(id));
      }),
    file: (imageId) =>
      read([FILES], async (tx) => (await requestResult(tx.objectStore(FILES).get(imageId))) as StoredFile | undefined),
    comments: (imageId) =>
      read([COMMENTS], async (tx) => {
        const rows = (await requestResult(tx.objectStore(COMMENTS).index(BY_IMAGE).getAll(imageId))) as CommentRecord[];
        return rows.sort(newerFirst);
      }),
    comment: (id) =>
      read(
        [COMMENTS],
        async (tx) => (await requestResult(tx.objectStore(COMMENTS).get(id))) as CommentRecord | undefined,
      ),
    insertComment: (comment) =>
      write([IMAGES, COMMENTS, META], async (tx) => {
        // The API's foreign key: a comment on an image deleted meanwhile is refused, not orphaned.
        const image: unknown = await requestResult(tx.objectStore(IMAGES).get(comment.imageId));
        if (image === undefined) throw new MissingImageError(`Image ${String(comment.imageId)} does not exist.`);
        const state = await readState(tx);
        const row: CommentRecord = { ...comment, id: state.nextCommentId };
        await requestResult(tx.objectStore(COMMENTS).add(row));
        await requestResult(tx.objectStore(META).put({ ...state, nextCommentId: row.id + 1 }, STATE_KEY));
        return row;
      }),
    deleteComment: (id) =>
      write([COMMENTS], async (tx) => {
        await requestResult(tx.objectStore(COMMENTS).delete(id));
      }),
    reset: () => write(ALL_STORES, (tx) => writeSeed(tx, seed, newOwnerId())),
    close: () => {
      db.close();
    },
  };
}
