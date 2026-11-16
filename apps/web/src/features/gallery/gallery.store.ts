import type { ImageDto } from '@app/shared';
import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

import { ApiError, GENERIC_ERROR_MESSAGE, isApiError } from '../../shared/api/api-error';
import { fetchImagePage } from './gallery.api';

/** First page: `idle` before the first load, then `loading` → `ready` | `error`. */
export type GalleryStatus = 'idle' | 'loading' | 'ready' | 'error';
/** "Load more": independent of `status`, so loaded tiles stay visible while a later page loads or fails (F-08). */
export type GalleryMoreStatus = 'idle' | 'loading' | 'error';

/** The HTTP client only rejects with `ApiError`; anything else is a bug and gets the generic message. */
function toApiError(cause: unknown): ApiError {
  if (isApiError(cause)) return cause;
  return new ApiError({ status: 0, code: 'unexpected-response', detail: GENERIC_ERROR_MESSAGE });
}

/**
 * The loaded gallery (OVERVIEW §8.1, ADR 0010). It lives in Pinia because it must survive opening and closing the
 * detail dialog (a nested route) and because HomePage applies upload and delete results to it without a reload
 * (F-04, F-37, B-47).
 *
 * Public API frozen by the scaffold (ADR 0017): `items`, `nextCursor`, `status`, `moreStatus`, `error`,
 * `loadFirst()`, `loadMore()`, `retry()`, `prepend(image)`, `remove(id)`.
 *
 * Pages are appended with de-duplication by `id` (F-04). The server's keyset cursor guarantees no gaps or repeats
 * between pages; the client guards the two races it can see itself: an upload prepended while the first page is in
 * flight, and a delete that happens while a page containing that image is in flight.
 */
export const useGalleryStore = defineStore('gallery', () => {
  const items = shallowRef<readonly ImageDto[]>([]);
  /** Opaque keyset cursor of the next older page; `null` hides "load more" (F-05, B-46). */
  const nextCursor = shallowRef<string | null>(null);
  const status = shallowRef<GalleryStatus>('idle');
  const moreStatus = shallowRef<GalleryMoreStatus>('idle');
  /** The failure behind `status === 'error'` or `moreStatus === 'error'`, for the inline error message. */
  const error = shallowRef<ApiError | null>(null);

  /** Ids removed in this session; a page that was already in flight must not bring them back. Not UI state. */
  const removedIds = new Set<number>();
  let firstRequest: Promise<void> | null = null;
  let moreRequest: Promise<void> | null = null;

  /** Keeps the current order and appends only ids that are neither loaded nor removed. */
  function appendPage(page: readonly ImageDto[]): void {
    const known = new Set(items.value.map((item) => item.id));
    const fresh = page.filter((item) => !known.has(item.id) && !removedIds.has(item.id));
    if (fresh.length > 0) items.value = [...items.value, ...fresh];
  }

  async function fetchFirst(): Promise<void> {
    status.value = 'loading';
    error.value = null;
    try {
      const page = await fetchImagePage();
      // Images uploaded while this page was in flight are already in `items` and stay on top (F-17).
      appendPage(page.items);
      nextCursor.value = page.nextCursor;
      status.value = 'ready';
    } catch (cause) {
      error.value = toApiError(cause);
      status.value = 'error';
    }
  }

  async function fetchMore(cursor: string): Promise<void> {
    moreStatus.value = 'loading';
    error.value = null;
    try {
      const page = await fetchImagePage({ cursor });
      appendPage(page.items);
      nextCursor.value = page.nextCursor;
      moreStatus.value = 'idle';
    } catch (cause) {
      error.value = toApiError(cause);
      moreStatus.value = 'error';
    }
  }

  /** Loads the first page (no-op once loaded; while loading it returns the request in flight). */
  function loadFirst(): Promise<void> {
    if (firstRequest !== null) return firstRequest;
    if (status.value === 'ready') return Promise.resolve();
    firstRequest = fetchFirst().finally(() => {
      firstRequest = null;
    });
    return firstRequest;
  }

  /** Appends the next page when `nextCursor` is set (no-op otherwise; while loading it returns that request). */
  function loadMore(): Promise<void> {
    if (moreRequest !== null) return moreRequest;
    const cursor = nextCursor.value;
    if (status.value !== 'ready' || cursor === null) return Promise.resolve();
    moreRequest = fetchMore(cursor).finally(() => {
      moreRequest = null;
    });
    return moreRequest;
  }

  /** Repeats whichever load failed, keeping the loaded items. */
  function retry(): Promise<void> {
    if (status.value === 'error') return loadFirst();
    if (moreStatus.value === 'error') return loadMore();
    return Promise.resolve();
  }

  /** A new upload goes on top (F-17); an id that is already loaded is moved, never duplicated. */
  function prepend(image: ImageDto): void {
    items.value = [image, ...items.value.filter((item) => item.id !== image.id)];
  }

  /** Drops a deleted image from the loaded list without resetting pages or scroll position (F-37). */
  function remove(id: number): void {
    removedIds.add(id);
    items.value = items.value.filter((item) => item.id !== id);
  }

  return { items, nextCursor, status, moreStatus, error, loadFirst, loadMore, retry, prepend, remove };
});
