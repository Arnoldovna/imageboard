import { PROBLEM_CODES, type FieldError, type ProblemCode, type ProblemDetails } from '@app/shared';

/**
 * Codes the client creates itself; the API never sends them (API.md §0, OVERVIEW §12):
 * - `network`: `fetch` rejected (offline, DNS, connection reset).
 * - `unexpected-response`: a non-2xx status without a problem body (nginx 413/502/504), or a body that does not
 *   match the response schema.
 */
export type ClientErrorCode = 'network' | 'unexpected-response';

/** A known problem code, a client code, or an unknown code from a newer API (tolerant reader, ADR 0010). */
export type ApiErrorCode = ProblemCode | ClientErrorCode | (string & {});

/** Shown for problem codes this client does not know yet. */
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Try again in a moment.';

/** Shown when a success body does not match the shared schema (a broken render would be worse). */
export const INVALID_RESPONSE_MESSAGE = 'The app could not read the server response. Reload the page and try again.';

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  /** User-facing sentence, safe to render as text. */
  detail: string;
  fieldErrors?: Readonly<Record<string, string>>;
  requestId?: string | undefined;
}

/**
 * Every failed request ends up as an `ApiError`. Components switch on `code` (never on `detail` text) and render
 * `detail` and `fieldErrors` as text. Aborted requests are not converted: they reject with the platform's
 * `AbortError` (see `isAbortError`).
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status; 0 when no response arrived (`network`). */
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly detail: string;
  /** First message per field name (`title`, `file`, …) from the problem's `errors[]`. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.detail);
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.fieldErrors = init.fieldErrors ?? {};
    this.requestId = init.requestId;
  }

  /** True when the server reported at least one invalid field. */
  get hasFieldErrors(): boolean {
    return Object.keys(this.fieldErrors).length > 0;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** `fetch` and `AbortSignal` reject with a DOMException named `AbortError`; callers ignore those. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const KNOWN_CODES: ReadonlySet<string> = new Set(PROBLEM_CODES);

export function isKnownProblemCode(code: string): code is ProblemCode {
  return KNOWN_CODES.has(code);
}

function toFieldErrors(errors: readonly FieldError[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const error of errors ?? []) {
    // Keep the first message per field: the API lists the most relevant issue first.
    result[error.field] ??= error.message;
  }
  return result;
}

/** Maps a parsed RFC 9457 body to an `ApiError`. Unknown codes keep their code but get the generic message. */
export function apiErrorFromProblem(problem: ProblemDetails, status: number): ApiError {
  return new ApiError({
    status,
    code: problem.code,
    detail: isKnownProblemCode(problem.code) ? problem.detail : GENERIC_ERROR_MESSAGE,
    fieldErrors: toFieldErrors(problem.errors),
    requestId: problem.requestId,
  });
}

/** Message for any rejection a component may catch (ApiError or not). */
export function errorMessage(error: unknown): string {
  return isApiError(error) ? error.detail : GENERIC_ERROR_MESSAGE;
}
