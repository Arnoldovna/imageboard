import { notOwnerMessages } from '@app/shared';

import { NotFoundError, NotOwnerError } from '../../shared/errors/app-error.js';
import { decodeCursor, toPage } from '../../shared/pagination/cursor.js';
import { type Actor, requireOwnerId } from '../../shared/session/actor.js';
import type { CommentDto, CommentPage, CreateCommentBody } from './comments.schema.js';
import type { CommentRecord, CommentsRepository } from './comments.repository.js';

export interface CommentsServiceDeps {
  repository: CommentsRepository;
  /** Injected by the composition root from the images module (ADR 0017); features never import each other. */
  imageExists: (id: number) => Promise<boolean>;
}

export interface ListCommentsInput {
  limit: number;
  cursor?: string | undefined;
}

/**
 * Comment rules (API.md §3): newest first with keyset pages, 404 for an unknown image, ownership by the anonymous
 * session (ADR 0002). `owner_id` never leaves this service: DTOs carry `canDelete` instead (F-32, F-43).
 */
export function createCommentsService({ repository, imageExists }: CommentsServiceDeps) {
  /** Exactly the `CommentDto` keys. */
  const toDto = (row: CommentRecord, actor: Actor): CommentDto => ({
    id: row.id,
    imageId: row.imageId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    canDelete: actor.ownerId !== null && row.ownerId === actor.ownerId,
  });

  return {
    /**
     * One page of an image's comments (F-27, F-31). An empty **first** page is ambiguous (no comments yet, or no such
     * image), so only then the image's existence is checked: a 404 costs one primary-key lookup, a filled page none.
     */
    async list(actor: Actor, imageId: number, { limit, cursor }: ListCommentsInput): Promise<CommentPage> {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const rows = await repository.listForImage(imageId, { limit, after });
      if (rows.length === 0 && after === undefined && !(await imageExists(imageId))) {
        throw new NotFoundError('Image');
      }
      const page = toPage(rows, limit);
      return { items: page.items.map((row) => toDto(row, actor)), nextCursor: page.nextCursor };
    },

    /** The new comment belongs to the actor's session; an unknown or meanwhile deleted image is a 404 (B-26). */
    async create(actor: Actor, imageId: number, input: CreateCommentBody): Promise<CommentDto> {
      const ownerId = requireOwnerId(actor);
      const row = await repository.insert({ imageId, authorName: input.authorName, body: input.body, ownerId });
      if (row === undefined) throw new NotFoundError('Image');
      return toDto(row, actor);
    },

    /**
     * Only the session that wrote a comment may delete it (F-32). The delete is one statement filtered by owner; when
     * it removes nothing, a lookup decides between 404 and 403. If the row vanished in between (its owner deleted
     * it), the answer is 404, which is correct (DATA-MODEL §4).
     */
    async remove(actor: Actor, id: number): Promise<void> {
      const ownerId = requireOwnerId(actor);
      if (await repository.deleteOwned(id, ownerId)) return;
      if (await repository.exists(id)) throw new NotOwnerError(notOwnerMessages.comment);
      throw new NotFoundError('Comment');
    },
  };
}

export type CommentsService = ReturnType<typeof createCommentsService>;
