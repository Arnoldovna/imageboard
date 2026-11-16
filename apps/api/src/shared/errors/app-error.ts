import { type FieldError, fileMessages, problemMessages, type ProblemCode } from '@app/shared';

export type ProblemExtensions = Readonly<Record<string, unknown>>;

interface AppErrorInit {
  status: number;
  /** Stable code from the shared contract (OVERVIEW §12). Becomes the problem `type` and the `code` member. */
  code: ProblemCode;
  title: string;
  /** Human-readable, client-safe explanation. Never include secrets, SQL or stack traces. */
  detail?: string;
  cause?: unknown;
  extensions?: ProblemExtensions;
}

/** Base class for every error the API deliberately exposes to clients (RFC 9457 problem details, ADR 0009). */
export class AppError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly extensions: ProblemExtensions;

  constructor(init: AppErrorInit) {
    super(init.detail ?? problemMessages[init.code], { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.extensions = init.extensions ?? {};
  }
}

/** One issue in `errors[]`: `{ field, location, message }` (FEATURES F-18, shared `FieldError`). */
export type ValidationIssue = FieldError;

/** 400 `validation-failed`: every issue of params, query, body and file at once. */
export class ValidationError extends AppError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], cause?: unknown) {
    super({
      status: 400,
      code: 'validation-failed',
      title: 'Validation failed',
      cause,
      extensions: { errors: issues },
    });
    this.issues = issues;
  }
}

/** 400 `invalid-cursor`: a pagination cursor that does not decode (ADR 0007). */
export class InvalidCursorError extends AppError {
  constructor(cause?: unknown) {
    super({ status: 400, code: 'invalid-cursor', title: 'Invalid cursor', cause });
  }
}

/** 400 `malformed-request`: unreadable JSON or multipart, unexpected parts. */
export class MalformedRequestError extends AppError {
  constructor(detail?: string, cause?: unknown) {
    super({ status: 400, code: 'malformed-request', title: 'Malformed request', ...(detail ? { detail } : {}), cause });
  }
}

/** 400 `invalid-image`: the bytes looked like an allowed image but cannot be processed (ADR 0005). */
export class InvalidImageError extends AppError {
  constructor(detail: string = fileMessages.unreadable, cause?: unknown) {
    super({ status: 400, code: 'invalid-image', title: 'Invalid image', detail, cause });
  }
}

type ForbiddenCode = Extract<ProblemCode, 'csrf-invalid' | 'cross-origin-request' | 'session-required' | 'not-owner'>;

/** 403 with one of the stable security or ownership codes. */
export class ForbiddenError extends AppError {
  constructor(code: ForbiddenCode, detail?: string, cause?: unknown) {
    super({ status: 403, code, title: 'Forbidden', ...(detail ? { detail } : {}), cause });
  }
}

/** 403 `not-owner`, raised by services (ADR 0002). */
export class NotOwnerError extends ForbiddenError {
  constructor(detail: string) {
    super('not-owner', detail);
  }
}

/** 404 `not-found`: "Image was not found." */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ status: 404, code: 'not-found', title: 'Not found', detail: `${resource} was not found.` });
  }
}

/** 413 `payload-too-large`. */
export class PayloadTooLargeError extends AppError {
  constructor(detail: string, cause?: unknown) {
    super({ status: 413, code: 'payload-too-large', title: 'Payload too large', detail, cause });
  }
}

/** 415 `unsupported-content-type`: wrong request Content-Type for the endpoint. */
export class UnsupportedContentTypeError extends AppError {
  constructor(detail: string) {
    super({ status: 415, code: 'unsupported-content-type', title: 'Unsupported media type', detail });
  }
}

/** 415 `unsupported-image-type`: the magic bytes are not JPEG, PNG (incl. APNG), WebP or GIF (F-19). */
export class UnsupportedImageTypeError extends AppError {
  constructor() {
    super({ status: 415, code: 'unsupported-image-type', title: 'Unsupported image type' });
  }
}

/** 429 `rate-limited`; the limiter sets `Retry-After` and the `RateLimit` headers (ADR 0013). */
export class TooManyRequestsError extends AppError {
  constructor() {
    super({ status: 429, code: 'rate-limited', title: 'Too many requests' });
  }
}
