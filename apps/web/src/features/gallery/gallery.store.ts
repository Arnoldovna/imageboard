import type { ImageDto } from '@app/shared';
import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

import type { ApiError } from '../../shared/api/api-error';

/** First page: `idle` before the first load, then `loading` → `ready` | `error`. */
export type GalleryStatus = 'idle' | 'loading' | 'ready' | 'error';
/** "Load more": independent of `status`, so loaded tiles stay visible while a later page loads or fails (F-08). */
export type GalleryMoreStatus = 'idle' | 'loading' | 'error';

/**
 * The loaded gallery (OVERVIEW §8.1, ADR 0010). It lives in Pinia because it must survive opening and closing the
 * detail dialog (a nested route) and because HomePage applies upload and delete results to it without a reload
 * (F-04, F-37, B-47).
 *
 * Public API frozen by the scaffold (ADR 0017): `items`, `nextCursor`, `status`, `moreStatus`, `error`,
 * `loadFirst()`, `loadMore()`, `retry()`, `prepend(image)`, `remove(id)`.
 *
 * SCAFFOLD STUB: `prepend` and `remove` are final; `loadFirst`, `loadMore` and `retry` resolve without loading
 * anything until the gallery module (BUILD-ORDER 3.1) implements them with `gallery.api.ts`. Pages are appended
 * with de-duplication by `id`.
 */
export const useGalleryStore = defineStore('gallery', () => {
  const items = shallowRef<readonly ImageDto[]>([]);
  /** Opaque keyset cursor of the next older page; `null` hides "load more" (F-05, B-46). */
  const nextCursor = shallowRef<string | null>(null);
  const status = shallowRef<GalleryStatus>('idle');
  const moreStatus = shallowRef<GalleryMoreStatus>('idle');
  /** The failure behind `status === 'error'` or `moreStatus === 'error'`, for the inline error message. */
  const error = shallowRef<ApiError | null>(null);

  /** Loads the first page (no-op while loading or once loaded). */
  function loadFirst(): Promise<void> {
    return Promise.resolve();
  }

  /** Appends the next page when `nextCursor` is set. */
  function loadMore(): Promise<void> {
    return Promise.resolve();
  }

  /** Repeats whichever load failed, keeping the loaded items. */
  function retry(): Promise<void> {
    return Promise.resolve();
  }

  /** A new upload goes on top (F-17); an id that is already loaded is moved, never duplicated. */
  function prepend(image: ImageDto): void {
    items.value = [image, ...items.value.filter((item) => item.id !== image.id)];
  }

  /** Drops a deleted image from the loaded list without resetting pages or scroll position (F-37). */
  function remove(id: number): void {
    items.value = items.value.filter((item) => item.id !== id);
  }

  return { items, nextCursor, status, moreStatus, error, loadFirst, loadMore, retry, prepend, remove };
});
