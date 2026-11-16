// Request and response shapes of the comments endpoints. The contract lives in `@app/shared` (API.md §3); this file
// only adds the route-param objects and the list query bound to the configured page size.
import { IdParam, LIMITS, pageQuery } from '@app/shared';
import { z } from 'zod';

// Each name is both the Zod schema and its inferred type.
export { CommentDto, CommentPage, CreateCommentBody } from '@app/shared';

/** `/api/images/:imageId/comments` (router mounted with `mergeParams`). Strict: no other param can appear. */
export const ImageCommentsParams = z.strictObject({ imageId: IdParam });

/** `DELETE /api/comments/:id`. */
export const CommentIdParams = z.strictObject({ id: IdParam });

/**
 * `?limit=&cursor=` for the comment list: empty `limit` → COMMENTS_PAGE_SIZE, non-integer → 400, out of range →
 * clamped to 1..50 (F-31, ADR 0007).
 */
export function listCommentsQuery(pageSize: number) {
  return pageQuery(pageSize, LIMITS.commentsPage.max);
}
