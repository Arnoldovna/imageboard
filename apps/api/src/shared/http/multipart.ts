import { fieldMessages, requestMessages } from '@app/shared';
import type { RequestHandler } from 'express';
import multer from 'multer';

import { MalformedRequestError, UnsupportedContentTypeError, ValidationError } from '../errors/app-error.js';

export interface MultipartLimits {
  maxFileBytes: number;
}

/**
 * Text parts of `POST /api/images` (ADR 0005) and the message for each when it exceeds the part size. A Map, so a part
 * named `constructor` or `__proto__` never resolves to an inherited `Object.prototype` member.
 */
const TEXT_FIELD_TOO_LONG: ReadonlyMap<string, string> = new Map([
  ['authorName', fieldMessages.authorName.tooLong],
  ['title', fieldMessages.title.tooLong],
  ['description', fieldMessages.description.tooLong],
]);
const MAX_FIELDS = TEXT_FIELD_TOO_LONG.size;
/** 2000 code points × 4 bytes plus CRs fit comfortably (API.md §2). */
const MAX_FIELD_BYTES = 16 * 1024;

/**
 * A known text part over the part size is `400 validation-failed` on that field with the field's own message (F-18).
 * Any other multer error goes on unchanged; `shared/http/problem.ts` maps it (413, 400 on the field, 400 malformed).
 */
function withFieldMessage(error: multer.MulterError): Error {
  const { field } = error;
  const message =
    error.code === 'LIMIT_FIELD_VALUE' && field !== undefined ? TEXT_FIELD_TOO_LONG.get(field) : undefined;
  if (field === undefined || message === undefined) return error;
  return new ValidationError([{ field, location: 'body', message }], error);
}

/**
 * The upload parser, shared so the images router runs the real thing while its tests fake the upload port
 * (ADR 0017). 415 unless multipart/form-data; then multer memoryStorage().single('file') with
 * `{ fileSize: maxFileBytes, files: 1, fields: 3, fieldSize: 16 KiB, parts: 4 }`. Bytes stay in memory: nothing is
 * staged on disk, so nothing can leak there (B-19, B-34).
 *
 * Busboy's own parse errors (truncated body, missing boundary) are plain `Error`s and become `400 malformed-request`.
 */
export function createMultipartParser(limits: MultipartLimits): RequestHandler {
  const single = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: limits.maxFileBytes,
      files: 1,
      fields: MAX_FIELDS,
      fieldSize: MAX_FIELD_BYTES,
      parts: MAX_FIELDS + 1,
    },
  }).single('file');

  return (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next(new UnsupportedContentTypeError(requestMessages.multipartRequired));
      return;
    }
    single(req, res, (error: unknown) => {
      if (error === undefined || error === null) {
        next();
      } else if (error instanceof multer.MulterError) {
        next(withFieldMessage(error));
      } else {
        next(new MalformedRequestError(requestMessages.malformed, error));
      }
    });
  };
}
