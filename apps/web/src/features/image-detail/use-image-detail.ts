import { LIMITS, type ImageDto } from '@app/shared';
import { computed, onScopeDispose, shallowReadonly, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';

import { errorMessage, isAbortError, isApiError } from '../../shared/api/http';
import { getImage } from './image-detail.api';

/**
 * What the dialog can show for one id (ADR 0010, B-49). The template switches on `status` and only reads `image` in
 * the `ready` branch, so it never touches fields of data that is missing.
 */
export type ImageDetailState =
  | { readonly status: 'loading'; readonly id: number }
  | { readonly status: 'ready'; readonly id: number; readonly image: ImageDto }
  | { readonly status: 'notFound'; readonly id: number }
  | { readonly status: 'error'; readonly id: number; readonly message: string };

/** Ids the API can know: a positive integer up to the largest Postgres `integer` (F-44). */
function isKnownIdRange(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 1 && id <= LIMITS.maxId;
}

/**
 * 404 means the image does not exist (any more). The router accepts every run of digits, so an out-of-range id
 * reaches the API, which answers 400 for the path id; for the person both mean "Image not found" (ADR 0011).
 */
function isMissing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || (error.status === 400 && error.code === 'validation-failed'));
}

/**
 * Loads the image of the open detail dialog (OVERVIEW §8.1, F-16, B-48):
 * - keyed by `id` (the route param): one request per id, started immediately and again only when the id changes;
 * - the previous request is aborted when the id changes or the owner unmounts, and a late answer for an old id is
 *   ignored, so image A's data never appears under image B's URL;
 * - `loading` is set synchronously on every change, so the dialog shows the loading state right away;
 * - `retry()` loads the current id again after an error.
 */
export function useImageDetail(id: MaybeRefOrGetter<number>) {
  const state = shallowRef<ImageDetailState>({ status: 'loading', id: toValue(id) });
  let controller: AbortController | null = null;

  async function load(target: number): Promise<void> {
    controller?.abort();
    controller = null;

    if (!isKnownIdRange(target)) {
      // Nothing the API could find: skip the request (the answer would be a 400).
      state.value = { status: 'notFound', id: target };
      return;
    }

    const current = new AbortController();
    controller = current;
    state.value = { status: 'loading', id: target };
    try {
      const image = await getImage(target, current.signal);
      if (controller !== current) return;
      state.value = { status: 'ready', id: target, image };
    } catch (error) {
      if (isAbortError(error) || controller !== current) return;
      state.value = isMissing(error)
        ? { status: 'notFound', id: target }
        : { status: 'error', id: target, message: errorMessage(error) };
    } finally {
      if (controller === current) controller = null;
    }
  }

  watch(
    () => toValue(id),
    (target) => {
      void load(target);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    controller?.abort();
    controller = null;
  });

  /** The loaded image, or null in every other state. */
  const image = computed<ImageDto | null>(() => (state.value.status === 'ready' ? state.value.image : null));

  function retry(): void {
    void load(toValue(id));
  }

  return { state: shallowReadonly(state), image, retry };
}
