import { ImagePage } from '@app/shared';

import { request, withQuery } from '../../shared/api/http';

/** `GET /api/images` (API.md): newest first, `nextCursor` null when no older image exists. */
const IMAGES_PATH = '/api/images';

export interface FetchImagePageOptions {
  /** Opaque keyset cursor from the previous page; omitted (or null) for the first page. */
  cursor?: string | null;
  signal?: AbortSignal;
}

/**
 * One gallery page, validated with the shared `ImagePage` schema; the page size is the server's `IMAGES_PAGE_SIZE`
 * (12, F-02). Rejects with `ApiError` (or `AbortError`).
 */
export function fetchImagePage(options: FetchImagePageOptions = {}): Promise<ImagePage> {
  const path = withQuery(IMAGES_PATH, { cursor: options.cursor });
  return request('GET', path, { schema: ImagePage, signal: options.signal });
}
