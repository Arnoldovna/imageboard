import { z } from 'zod';

import { LIMITS } from './limits.js';
import { fieldMessages } from './messages.js';
import { pageOf } from './pagination.js';
import { multiLineText, singleLineText } from './text.js';

/** Response DTO (F-43); tolerant reader like `ImageDto`. `owner_id` never appears here. */
export const CommentDto = z.object({
  id: z.number().int().positive(),
  imageId: z.number().int().positive(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime({ precision: 3 }),
  canDelete: z.boolean(),
});
export type CommentDto = z.infer<typeof CommentDto>;

export const CommentPage = pageOf(CommentDto);
export type CommentPage = z.infer<typeof CommentPage>;

/** JSON body of `POST /api/images/:imageId/comments` (F-29). Strict: unknown keys are a 400. */
export const CreateCommentBody = z.strictObject({
  authorName: singleLineText({ ...LIMITS.authorName, messages: fieldMessages.authorName }),
  body: multiLineText({ ...LIMITS.commentBody, messages: fieldMessages.commentBody }),
});
export type CreateCommentBody = z.output<typeof CreateCommentBody>;
export type CreateCommentBodyInput = z.input<typeof CreateCommentBody>;
