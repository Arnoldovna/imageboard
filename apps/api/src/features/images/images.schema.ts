// Request and response schemas of the images feature. The contract lives in `@app/shared` (OVERVIEW §7); this file
// re-exports it and adds the server-only shapes of route params and query strings.
import { CreateImageFields, IdParam, ImageDto, ImagePage, LIMITS, pageQuery } from '@app/shared';
import { z } from 'zod';

export { CreateImageFields, ImageDto, ImagePage };

/** `/api/images/:id` (F-13, F-44): canonical positive integer up to 2^31−1, else `400 validation-failed`. */
export const ImageIdParams = z.strictObject({ id: IdParam });

/**
 * `GET /api/images?limit=&cursor=` (F-02): empty `limit` → IMAGES_PAGE_SIZE, non-integer → 400, out of range →
 * clamped to 1..50. The cursor is checked for shape here and decoded by the service (ADR 0007).
 */
export function listImagesQuery(pageSize: number) {
  return pageQuery(pageSize, LIMITS.imagesPage.max);
}
export type ListImagesQuery = z.output<ReturnType<typeof listImagesQuery>>;
