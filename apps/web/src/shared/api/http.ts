import { uploadTooLarge } from '@app/shared';

import { useSessionStore } from '../session/session.store';
import { isApiError } from './api-error';
import { exchange, type HttpMethod, type ResponseSchema, type SendOptions } from './transport';

export { ApiError, errorMessage, isAbortError, isApiError, type ApiErrorCode } from './api-error';
export type { HttpMethod, ResponseSchema } from './transport';

export interface RequestOptions<T> {
  /** Shared Zod schema for the 2xx body (`ImageDto`, `CommentPage`, …). Omit for `204` responses. */
  schema?: ResponseSchema<T>;
  /** JSON body (mutations). */
  body?: unknown;
  /** Multipart body (the image upload). */
  formData?: FormData;
  signal?: AbortSignal;
}

/**
 * The one HTTP client of the SPA (OVERVIEW §8.1, ADR 0010), on native `fetch`:
 * - `credentials: 'same-origin'`, JSON or multipart bodies, `AbortSignal` support;
 * - mutations (POST, DELETE) await the session store and send `x-csrf-token`; on `403 csrf-invalid` the session is
 *   refreshed once and the request is retried once (an expired session gets a new token);
 * - `application/problem+json` becomes an `ApiError` with `fieldErrors`; other failures become `network` or
 *   `unexpected-response`; 2xx bodies are validated with the given schema.
 *
 * Aborted requests reject with the platform `AbortError` (check with `isAbortError`), never with an `ApiError`.
 */
export function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<T> & { schema: ResponseSchema<T> },
): Promise<T>;
export function request(
  method: HttpMethod,
  path: string,
  options?: Omit<RequestOptions<never>, 'schema'>,
): Promise<void>;
export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<T> = {},
): Promise<T | undefined> {
  const base: SendOptions<T> = {
    schema: options.schema,
    body: options.body,
    formData: options.formData,
    signal: options.signal,
  };
  if (method === 'GET') return exchange(method, path, base);

  const session = useSessionStore();
  // Only an upload can outgrow nginx's body limit for a reason the user can act on: the image size.
  const isUpload = options.formData !== undefined;
  const mutation = (csrfToken: string): Promise<T | undefined> =>
    exchange(method, path, {
      ...base,
      csrfToken,
      ...(isUpload ? { payloadTooLargeMessage: uploadTooLarge(session.uploadMaxBytes) } : {}),
    });

  const token = await session.ensure();
  try {
    return await mutation(token);
  } catch (error) {
    if (!isApiError(error) || error.code !== 'csrf-invalid') throw error;
    options.signal?.throwIfAborted();
    return mutation(await session.refresh());
  }
}

/** Appends query parameters, skipping `undefined`, `null` and `''` (an empty cursor means "first page"). */
export function withQuery(path: string, query: Readonly<Record<string, string | number | null | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}
