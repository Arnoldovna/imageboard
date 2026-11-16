import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import multer from 'multer';

import { APP_SLUG } from '../../config/app.js';
import { AppError, NotFoundError } from '../errors/app-error.js';

/** RFC 9457 problem details. Extension members are allowed next to the standard fields. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/**
 * Problem `type` URIs are tag URIs (RFC 4151), which RFC 9457 lists as a valid non-resolvable choice.
 */
const PROBLEM_TYPE_PREFIX = `tag:arnoldovna.github.io,2026:${APP_SLUG}:problem:`;

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  413: 'Payload too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
  500: 'Internal server error',
};

/** Errors created by `http-errors` (body-parser, csrf-csrf, ...) carry `status` and `expose`. */
interface HttpErrorLike {
  status: number;
  expose: boolean;
  message: string;
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

function generic(status: number, req: Request, detail?: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: req.originalUrl,
  };
}

export function toProblem(error: unknown, req: Request): ProblemDetails {
  if (error instanceof AppError) {
    return {
      ...error.extensions,
      type: `${PROBLEM_TYPE_PREFIX}${error.code}`,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance: req.originalUrl,
    };
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return generic(status, req, error.message);
  }
  if (isHttpErrorLike(error) && error.status >= 400 && error.status < 500) {
    // csrf-csrf uses code EBADCSRFTOKEN; body-parser uses 400/413/415.
    return generic(error.status, req, error.expose ? error.message : undefined);
  }
  return generic(500, req, 'An unexpected error occurred.');
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * Must be registered last. Express 5 forwards rejected promises from async handlers here,
 * so handlers never need try/catch or an asyncHandler wrapper.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const problem = toProblem(error, req);
  if (problem.status >= 500) {
    req.log.error({ err: error }, 'request failed');
  } else {
    req.log.info({ problemType: problem.type, status: problem.status }, 'request rejected');
  }
  res.status(problem.status).type('application/problem+json').json(problem);
};
