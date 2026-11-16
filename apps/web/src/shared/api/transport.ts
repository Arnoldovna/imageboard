import { ProblemDetails, problemMessages, serviceUnavailable } from '@app/shared';

import { ApiError, apiErrorFromProblem, INVALID_RESPONSE_MESSAGE, isAbortError } from './api-error';

/**
 * The structural part of a Zod schema the client needs. Typing against this instead of importing `zod` keeps the
 * web app on the contract package only (OVERVIEW §6: `zod` only via `@app/shared`); every shared schema fits.
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface SendOptions<T> {
  /** Validates a 2xx body (tolerant DTOs). Without a schema the body is ignored (204, or a body nobody reads). */
  schema?: ResponseSchema<T> | undefined;
  /** Sent as JSON with `Content-Type: application/json`. */
  body?: unknown;
  /** Sent as `multipart/form-data`; the browser sets the boundary. */
  formData?: FormData | undefined;
  signal?: AbortSignal | undefined;
  /** `x-csrf-token` header value (mutations only). */
  csrfToken?: string | undefined;
  /**
   * Detail for a 413 that did not come from the API (nginx `client_max_body_size`). Uploads pass the image size limit;
   * without it the generic "The request is too large." applies.
   */
  payloadTooLargeMessage?: string | undefined;
}

const PROBLEM_JSON = 'application/problem+json';

/**
 * One HTTP exchange with the API: same-origin credentials, problem+json → `ApiError`, Zod validation of the body.
 * No CSRF handling and no retries: `http.ts` adds those for mutations. The session store uses this directly, so the
 * client and the store do not import each other.
 */
export function send<T>(
  method: HttpMethod,
  path: string,
  options: SendOptions<T> & { schema: ResponseSchema<T> },
): Promise<T>;
export function send(method: HttpMethod, path: string, options?: SendOptions<never>): Promise<void>;
export function send<T>(method: HttpMethod, path: string, options: SendOptions<T> = {}): Promise<T | undefined> {
  return exchange(method, path, options);
}

/** `send` without the overloads, for callers that pass an optional schema through (`http.ts`). */
export async function exchange<T>(method: HttpMethod, path: string, options: SendOptions<T>): Promise<T | undefined> {
  const headers = new Headers({ accept: `application/json, ${PROBLEM_JSON}` });
  let body: BodyInit | undefined;
  if (options.formData !== undefined) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  if (options.csrfToken !== undefined) headers.set('x-csrf-token', options.csrfToken);

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body ?? null,
      credentials: 'same-origin',
      signal: options.signal ?? null,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({ status: 0, code: 'network', detail: serviceUnavailable });
  }

  if (!response.ok) throw await errorFromResponse(response, options);
  // With a schema a body is required: an empty 204 is as wrong as a mistyped field.
  if (options.schema === undefined) return undefined;
  return parseBody(response, options.schema);
}

async function parseBody<T>(response: Response, schema: ResponseSchema<T>): Promise<T> {
  const invalid = new ApiError({
    status: response.status,
    code: 'unexpected-response',
    detail: INVALID_RESPONSE_MESSAGE,
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw invalid;
  }
  const result = schema.safeParse(json);
  if (!result.success) throw invalid;
  return result.data;
}

async function errorFromResponse(response: Response, options: SendOptions<unknown>): Promise<ApiError> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes(PROBLEM_JSON)) {
    try {
      const problem = ProblemDetails.safeParse(await response.json());
      if (problem.success) return apiErrorFromProblem(problem.data, response.status);
    } catch (error) {
      if (isAbortError(error)) throw error;
      // Not JSON after all: fall through to the generic mapping.
    }
  }
  const detail =
    response.status === 413
      ? (options.payloadTooLargeMessage ?? problemMessages['payload-too-large'])
      : serviceUnavailable;
  return new ApiError({ status: response.status, code: 'unexpected-response', detail });
}
