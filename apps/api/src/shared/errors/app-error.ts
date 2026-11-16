export type ProblemExtensions = Readonly<Record<string, unknown>>;

interface AppErrorInit {
  status: number;
  /** Stable, kebab-case identifier. Becomes the problem `type` and is safe to show to clients. */
  code: string;
  title: string;
  /** Human-readable, client-safe explanation. Never include secrets, SQL or stack traces. */
  detail: string;
  cause?: unknown;
  extensions?: ProblemExtensions;
}

/** Base class for every error the API deliberately exposes to clients (RFC 9457 problem details). */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extensions: ProblemExtensions;

  constructor(init: AppErrorInit) {
    super(init.detail, { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.extensions = init.extensions ?? {};
  }
}

export interface ValidationIssue {
  location: 'params' | 'query' | 'body' | 'file';
  /** Field name as the client knows it (FEATURES F-18: `{ field, message }`). */
  field: string;
  message: string;
}

export class ValidationError extends AppError {
  constructor(issues: readonly ValidationIssue[]) {
    super({
      status: 400,
      code: 'validation-failed',
      title: 'Validation failed',
      detail: 'The request contains invalid data.',
      extensions: { errors: issues },
    });
  }
}

export class BadRequestError extends AppError {
  constructor(detail: string, code = 'bad-request') {
    super({ status: 400, code, title: 'Bad request', detail });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required.') {
    super({ status: 401, code: 'unauthenticated', title: 'Unauthorized', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You are not allowed to perform this action.') {
    super({ status: 403, code: 'forbidden', title: 'Forbidden', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ status: 404, code: 'not-found', title: 'Not found', detail: `${resource} was not found.` });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, code = 'conflict') {
    super({ status: 409, code, title: 'Conflict', detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super({
      status: 413,
      code: 'payload-too-large',
      title: 'Payload too large',
      detail: `The upload exceeds the limit of ${String(maxBytes)} bytes.`,
      extensions: { maxBytes },
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(allowed: readonly string[]) {
    super({
      status: 415,
      code: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: `Allowed types: ${allowed.join(', ')}.`,
      extensions: { allowed },
    });
  }
}
