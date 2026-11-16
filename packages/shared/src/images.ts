import { z } from 'zod';

import { IMAGE_MIME_TYPES, LIMITS } from './limits.js';
import { fieldMessages } from './messages.js';
import { pageOf } from './pagination.js';
import { multiLineText, singleLineText } from './text.js';

export const ImageMimeType = z.enum(IMAGE_MIME_TYPES);
export type ImageMimeType = z.infer<typeof ImageMimeType>;

/**
 * Response DTO (F-43). `z.object` strips unknown keys (tolerant reader, ADR 0010); the API's own tests assert the
 * exact key set it sends. `owner_id` never appears here (B-28).
 */
export const ImageDto = z.object({
  id: z.number().int().positive(),
  /** `${MEDIA_PUBLIC_BASE_URL}/${objectKey}`: the stored original, shown in the dialog. */
  url: z.string().min(1),
  /** `${MEDIA_PUBLIC_BASE_URL}/previews/<uuid>.webp`: the gallery tile rendition (ADR 0018). */
  previewUrl: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: ImageMimeType,
  authorName: z.string(),
  title: z.string(),
  /** '' when none. */
  description: z.string(),
  createdAt: z.iso.datetime({ precision: 3 }),
  canDelete: z.boolean(),
});
export type ImageDto = z.infer<typeof ImageDto>;

export const ImagePage = pageOf(ImageDto);
export type ImagePage = z.infer<typeof ImagePage>;

/** Text parts of `POST /api/images` (F-18). Strict: an unknown field is a 400. The file part is checked separately. */
export const CreateImageFields = z.strictObject({
  authorName: singleLineText({ ...LIMITS.authorName, messages: fieldMessages.authorName }),
  title: singleLineText({ ...LIMITS.title, messages: fieldMessages.title }),
  description: multiLineText({ ...LIMITS.description, messages: fieldMessages.description }).default(''),
});
export type CreateImageFields = z.output<typeof CreateImageFields>;
export type CreateImageFieldsInput = z.input<typeof CreateImageFields>;
