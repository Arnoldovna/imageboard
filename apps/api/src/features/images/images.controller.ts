import { fileMessages } from '@app/shared';
import type { RequestHandler } from 'express';

import { ValidationError, type ValidationIssue } from '../../shared/errors/app-error.js';
import { toValidationIssues, validate } from '../../shared/http/validate.js';
import type { IncomingFile } from '../../shared/ports/image-upload.js';
import { actorOf, markSessionActive } from '../../shared/session/actor.js';
import { CreateImageFields, ImageIdParams, listImagesQuery } from './images.schema.js';
import type { ImagesService } from './images.service.js';

export interface ImagesControllerDeps {
  service: ImagesService;
  /** IMAGES_PAGE_SIZE: the default `limit` (F-02). */
  pageSize: number;
}

/**
 * The text parts and the file part of `POST /api/images`, validated together so the client gets every issue at once
 * (F-18, B-24). Only the bytes and their size go on: the client filename and client MIME type are never used (F-21).
 * An empty file part is what a browser sends for a file input without a file, so it counts as missing.
 */
function parseUpload(
  body: unknown,
  file: Express.Multer.File | undefined,
): { fields: CreateImageFields; file: IncomingFile } {
  const fields = CreateImageFields.safeParse(body ?? {});
  const issues: ValidationIssue[] = fields.success ? [] : toValidationIssues('body', fields.error.issues);
  const present = file !== undefined && file.size > 0 ? file : undefined;
  if (present === undefined) issues.push({ field: 'file', location: 'file', message: fileMessages.required });
  if (!fields.success || present === undefined) throw new ValidationError(issues);
  return { fields: fields.data, file: { buffer: present.buffer, size: present.size } };
}

/** HTTP ↔ service only: parse input, pick status codes and headers. No SQL, no rules. */
export function createImagesController({ service, pageSize }: ImagesControllerDeps) {
  const ListQuery = listImagesQuery(pageSize);

  const list = validate({ query: ListQuery }, async ({ query }, req, res) => {
    res.json(await service.list(actorOf(req), query));
  });

  const show = validate({ params: ImageIdParams }, async ({ params }, req, res) => {
    res.json(await service.get(actorOf(req), params.id));
  });

  /** Runs after `requireOwnerSession`, the upload limiters and the multipart parser (ADR 0017). */
  const create: RequestHandler = async (req, res) => {
    const upload = parseUpload(req.body, req.file);
    const image = await service.create(actorOf(req), upload.fields, upload.file);
    // The first post gives the session its full lifetime; set before the response so this response carries it.
    markSessionActive(req);
    res
      .status(201)
      .location(`/api/images/${String(image.id)}`)
      .json(image);
  };

  /** `204` without a body (B-23). */
  const remove = validate({ params: ImageIdParams }, async ({ params }, req, res) => {
    await service.remove(actorOf(req), params.id);
    res.status(204).end();
  });

  return { list, show, create, remove };
}

export type ImagesController = ReturnType<typeof createImagesController>;
