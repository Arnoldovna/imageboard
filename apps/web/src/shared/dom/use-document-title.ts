import { toValue, watch, type MaybeRefOrGetter } from 'vue';

export const APP_TITLE = 'Imageboard';

/** "Imageboard" or "<page> · Imageboard" (F-53, API.md §8). Blank parts fall back to the app title. */
export function formatDocumentTitle(page?: string | null): string {
  const trimmed = page?.trim() ?? '';
  return trimmed === '' ? APP_TITLE : `${trimmed} · ${APP_TITLE}`;
}

export function setDocumentTitle(page?: string | null): void {
  document.title = formatDocumentTitle(page);
}

/**
 * Keeps `document.title` in sync with a page title owned by a component (the image dialog: its title once loaded,
 * "Image not found" on 404, the plain app title while loading). The router sets titles of static routes; a
 * component-owned title is not restored on unmount, because the next route's title is already set by then.
 */
export function useDocumentTitle(page: MaybeRefOrGetter<string | null | undefined>): void {
  watch(
    () => toValue(page),
    (value) => {
      setDocumentTitle(value);
    },
    { immediate: true },
  );
}
