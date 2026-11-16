import { ImageDto } from '@app/shared';

import { request } from '../../shared/api/http';

/**
 * Typed calls of the image-detail feature (API.md §2), all through the one HTTP client: responses are validated
 * with the shared schema, failures arrive as `ApiError`, mutations carry the CSRF token.
 */

/** `GET /api/images/:id`: 404 `not-found` for an unknown id, 400 `validation-failed` for an out-of-range one. */
export function getImage(id: number, signal?: AbortSignal): Promise<ImageDto> {
  return request('GET', imagePath(id), { schema: ImageDto, signal });
}

/** `DELETE /api/images/:id`: 204 only for the session that uploaded it (403 `not-owner` otherwise, F-35). */
export function deleteImage(id: number): Promise<void> {
  return request('DELETE', imagePath(id));
}

function imagePath(id: number): string {
  return `/api/images/${String(id)}`;
}
