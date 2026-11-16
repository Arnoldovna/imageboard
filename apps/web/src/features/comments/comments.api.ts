import { CommentDto, CommentPage, type CreateCommentBody } from '@app/shared';

import { request, withQuery } from '../../shared/api/http';

/**
 * Typed calls of the comments endpoints (API.md §3, ADR 0010). Every success body is validated with the shared
 * schema by the HTTP client; failures reject with an `ApiError` (aborts with the platform `AbortError`).
 */

export interface ListCommentsOptions {
  /** Opaque keyset cursor from the previous page; omitted or `null` for the newest page. */
  cursor?: string | null;
  signal?: AbortSignal;
}

function imageCommentsPath(imageId: number): string {
  return `/api/images/${String(imageId)}/comments`;
}

/** `GET /api/images/:imageId/comments`: one page, newest first; the page size is the server default (F-27, F-31). */
export function listComments(imageId: number, options: ListCommentsOptions = {}): Promise<CommentPage> {
  return request('GET', withQuery(imageCommentsPath(imageId), { cursor: options.cursor }), {
    schema: CommentPage,
    signal: options.signal,
  });
}

/** `POST /api/images/:imageId/comments`: `201 CommentDto` with `canDelete: true` (F-28). */
export function createComment(imageId: number, body: CreateCommentBody): Promise<CommentDto> {
  return request('POST', imageCommentsPath(imageId), { schema: CommentDto, body });
}

/** `DELETE /api/comments/:id`: `204` for the session that wrote it, `403 not-owner` for anyone else (F-32). */
export function deleteComment(id: number): Promise<void> {
  return request('DELETE', `/api/comments/${String(id)}`);
}
