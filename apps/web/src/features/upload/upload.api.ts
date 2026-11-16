import { ImageDto, type CreateImageFields } from '@app/shared';

import { request } from '../../shared/api/http';

/**
 * Neutral filename for the file part. The API never uses the client's filename (F-21), so the person's local name
 * ("IMG_2041 Oslo flat.jpg") does not need to leave the browser at all. Multipart still needs one to mark the part
 * as a file.
 */
const FILE_PART_NAME = 'image';

/**
 * `POST /api/images` (API.md §2): multipart with the text parts first and exactly one `file` part. The shared client
 * adds the CSRF token, maps problems to `ApiError` and validates the `201` body as `ImageDto`.
 */
export function uploadImage(fields: CreateImageFields, file: Blob, signal?: AbortSignal): Promise<ImageDto> {
  const formData = new FormData();
  formData.append('authorName', fields.authorName);
  formData.append('title', fields.title);
  formData.append('description', fields.description);
  formData.append('file', file, FILE_PART_NAME);
  return request('POST', '/api/images', { schema: ImageDto, formData, signal });
}
