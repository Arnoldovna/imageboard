import { validate } from '../../shared/http/validate.js';
import { actorOf, markSessionActive } from '../../shared/session/actor.js';
import { CommentIdParams, CreateCommentBody, ImageCommentsParams, listCommentsQuery } from './comments.schema.js';
import type { CommentsService } from './comments.service.js';

export interface CommentsControllerDeps {
  service: CommentsService;
  /** COMMENTS_PAGE_SIZE: the `limit` when the client sends none. */
  pageSize: number;
}

/** HTTP <-> service translation only: validation, status codes and headers. No SQL, no rules. */
export function createCommentsController({ service, pageSize }: CommentsControllerDeps) {
  const ListCommentsQuery = listCommentsQuery(pageSize);

  return {
    /** `GET /api/images/:imageId/comments` → `200 CommentPage`. */
    list: validate({ params: ImageCommentsParams, query: ListCommentsQuery }, async ({ params, query }, req, res) => {
      const page = await service.list(actorOf(req), params.imageId, query);
      res.json(page);
    }),

    /**
     * `POST /api/images/:imageId/comments` → `201 CommentDto` **without** `Location`: there is no
     * `GET /api/comments/:id`, the body is the resource (API.md §3). The first comment gives a provisional session its
     * full lifetime, in this same response (F-34).
     */
    create: validate({ params: ImageCommentsParams, body: CreateCommentBody }, async ({ params, body }, req, res) => {
      const comment = await service.create(actorOf(req), params.imageId, body);
      markSessionActive(req);
      res.status(201).json(comment);
    }),

    /** `DELETE /api/comments/:id` → `204`. */
    remove: validate({ params: CommentIdParams }, async ({ params }, req, res) => {
      await service.remove(actorOf(req), params.id);
      res.status(204).end();
    }),
  };
}

export type CommentsController = ReturnType<typeof createCommentsController>;
