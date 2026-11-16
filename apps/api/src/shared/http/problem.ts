import { type ProblemCode, requestMessages, uploadTooLarge } from '@app/shared';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import multer from 'multer';

import { APP_SLUG } from '../../config/app.js';
import {
  AppError,
  ForbiddenError,
  MalformedRequestError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedContentTypeError,
  ValidationError,
} from '../errors/app-error.js';
import { textCheckViolation } from '../errors/db-errors.js';

/** RFC 9457 problem details as the API sends them (OVERVIEW §12). Extension members follow the standard ones. */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: ProblemCode;
  requestId?: string;
  [extension: string]: unknown;
}

export interface ProblemOptions {
  /** UPLOAD_MAX_BYTES, for the 413 message of an oversized upload. */
  uploadMaxBytes: number;
}

export type ProblemLogLevel = 'error' | 'warn' | 'info';

export interface ClassifiedProblem {
  problem: ProblemBody;
  /** 5xx: `error` with the error object; a DB CHECK that Zod let through: `warn`; other 4xx: `info` (ADR 0009). */
  level: ProblemLogLevel;
}

/** Tag URIs (RFC 4151) are a valid non-resolvable `type` per RFC 9457; clients switch on `code`. */
export const PROBLEM_TYPE_PREFIX = `tag:arnoldovna.github.io,2026:${APP_SLUG}:problem:`;

/** Errors created by `http-errors` (body-parser, csrf-csrf) carry `status`, `expose` and sometimes `code`. */
interface HttpErrorLike {
  status: number;
  expose: boolean;
  code?: unknown;
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    'expose' in error &&
    typeof error.expose === 'boolean'
  );
}

/**
 * Express' router rejects a path parameter with broken percent-encoding (`/api/images/%E0/comments`) with a plain
 * `URIError` whose `status` is 400 and which has no `expose`, so it is not an http-error.
 */
function isUndecodablePathParam(error: unknown): boolean {
  return error instanceof URIError && 'status' in error && error.status === 400;
}

/**
 * Field-specific messages are attached where the fields are known (the multipart parser for its text parts); here
 * only the generic mapping remains.
 */
function fromMulterError(error: multer.MulterError, options: ProblemOptions): AppError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return new PayloadTooLargeError(uploadTooLarge(options.uploadMaxBytes), error);
    case 'LIMIT_FIELD_VALUE':
      return new ValidationError(
        [{ field: error.field ?? 'unknown', location: 'body', message: requestMessages.fieldTooLong }],
        error,
      );
    default:
      // Second file, unexpected file field, too many fields or parts, field name problems.
      return new MalformedRequestError(requestMessages.malformed, error);
  }
}

/**
 * The client errors of the http-errors sources in this app (body-parser, csrf-csrf), each to the stable code of its
 * status (OVERVIEW §12). Any other status has no code that matches it; it means a new error source nobody mapped
 * yet, so it falls through to `500 internal-error` and is logged at `error` (ADR 0009, "everything else").
 */
function fromHttpError(error: HttpErrorLike): AppError | undefined {
  if (error.code === 'EBADCSRFTOKEN') return new ForbiddenError('csrf-invalid', undefined, error);
  switch (error.status) {
    case 400: // entity.parse.failed (bad JSON syntax), request.aborted, request.size.invalid
      return new MalformedRequestError(requestMessages.malformed, error);
    case 413: // entity.too.large
      return new PayloadTooLargeError(requestMessages.jsonBodyTooLarge, error);
    case 415: // encoding.unsupported, charset.unsupported
      return new UnsupportedContentTypeError(requestMessages.jsonRequired);
    default:
      return undefined;
  }
}

function internalError(error: unknown): AppError {
  return new AppError({ status: 500, code: 'internal-error', title: 'Internal server error', cause: error });
}

function classify(error: unknown, options: ProblemOptions): { appError: AppError; level: ProblemLogLevel } {
  if (error instanceof AppError) return { appError: error, level: error.status >= 500 ? 'error' : 'info' };
  if (error instanceof multer.MulterError) return { appError: fromMulterError(error, options), level: 'info' };
  const httpError = isHttpErrorLike(error) ? fromHttpError(error) : undefined;
  if (httpError !== undefined) return { appError: httpError, level: 'info' };
  if (isUndecodablePathParam(error)) {
    return { appError: new MalformedRequestError(requestMessages.malformed, error), level: 'info' };
  }
  const violation = textCheckViolation(error);
  if (violation !== undefined) {
    // Defence in depth (ADR 0006): Zod should have rejected this value, so the drift is logged at warn.
    const issue = { field: violation.field, location: 'body', message: violation.message } as const;
    return { appError: new ValidationError([issue], error), level: 'warn' };
  }
  return { appError: internalError(error), level: 'error' };
}

function requestIdOf(req: Request): string | undefined {
  const id: unknown = req.id;
  return typeof id === 'string' ? id : undefined;
}

/** Maps anything thrown or forwarded to a problem body. Never includes stacks, SQL or driver messages. */
export function toProblem(error: unknown, req: Request, options: ProblemOptions): ClassifiedProblem {
  const { appError, level } = classify(error, options);
  const requestId = requestIdOf(req);
  return {
    level,
    problem: {
      // Extensions first: they can never overwrite a standard member.
      ...appError.extensions,
      type: `${PROBLEM_TYPE_PREFIX}${appError.code}`,
      title: appError.title,
      status: appError.status,
      detail: appError.message,
      instance: req.originalUrl,
      code: appError.code,
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/** Unknown `/api/*` routes and methods (F-41). */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * Must be registered last. Express 5 forwards rejected promises from async handlers here, so handlers never need
 * try/catch or an asyncHandler wrapper (B-17).
 */
export function createErrorHandler(options: ProblemOptions): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const { problem, level } = toProblem(error, req, options);
    if (level === 'error') {
      req.log.error({ err: error }, 'request failed');
    } else if (level === 'warn') {
      req.log.warn({ err: error, code: problem.code }, 'database rejected a value that passed validation');
    } else {
      req.log.info({ code: problem.code, status: problem.status }, 'request rejected');
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  };
}
