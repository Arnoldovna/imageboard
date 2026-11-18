import { z } from 'zod';

import { fileMessages, requestMessages } from './messages.js';

/** Every `code` the API sends in a problem body (OVERVIEW §12). The web client switches on these, never on text. */
export const PROBLEM_CODES = [
  'validation-failed',
  'invalid-cursor',
  'malformed-request',
  'invalid-image',
  'csrf-invalid',
  'cross-origin-request',
  'session-required',
  'not-owner',
  'not-found',
  'payload-too-large',
  'unsupported-image-type',
  'unsupported-content-type',
  'rate-limited',
  'internal-error',
] as const;

export const ProblemCode = z.enum(PROBLEM_CODES);
export type ProblemCode = z.infer<typeof ProblemCode>;

/** Default `detail` per problem code. Specific errors may pass a more precise detail ("Image was not found."). */
export const problemMessages: Readonly<Record<ProblemCode, string>> = {
  'validation-failed': 'The request contains invalid data.',
  'invalid-cursor': requestMessages.invalidCursor,
  'malformed-request': requestMessages.malformed,
  'invalid-image': fileMessages.unreadable,
  'csrf-invalid': 'The security token is missing or no longer valid. Reload the page and try again.',
  'cross-origin-request': 'Requests from other sites are not allowed.',
  'session-required': 'Your browser session has expired. Reload the page and try again.',
  'not-owner': 'You can only delete what you created.',
  'not-found': 'The requested resource was not found.',
  'payload-too-large': 'The request is too large.',
  'unsupported-image-type': fileMessages.unsupportedType,
  'unsupported-content-type': 'The request has an unsupported content type.',
  'rate-limited': 'Too many requests. Wait a moment and try again.',
  'internal-error': 'An unexpected error occurred.',
};

export const FieldErrorLocation = z.enum(['params', 'query', 'body', 'file']);
export type FieldErrorLocation = z.infer<typeof FieldErrorLocation>;

/** One validation issue: `field` is the name the client knows ('title', 'file', 'cursor', 'id', ...). */
export const FieldError = z.object({
  field: z.string(),
  location: FieldErrorLocation,
  message: z.string(),
});
export type FieldError = z.infer<typeof FieldError>;

/**
 * RFC 9457 problem details as the client parses them. Tolerant reader (ADR 0009/0010): unknown members are kept,
 * and an unknown `code` from a newer API is accepted as a string so the client falls back to a generic message.
 */
export const ProblemDetails = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: ProblemCode.or(z.string()),
  requestId: z.string().optional(),
  errors: z.array(FieldError).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** The parts of a Zod issue `toFieldErrors` reads; every issue of the shared schemas fits. */
export interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
}

/**
 * Zod issues → `{ field, location, message }` (F-18). `field` is the dotted path as the client knows it; an issue on
 * the whole part (body missing, not an object) is reported on `rootField`, by default the part itself. Unknown keys
 * of a strict schema become one issue per key, so the client can point at each. Used by the API's `validate` and by
 * the live demo, so both report validation errors identically.
 */
export function toFieldErrors(
  location: FieldErrorLocation,
  issues: readonly IssueLike[],
  rootField: string = location,
): FieldError[] {
  return issues.flatMap((issue): FieldError[] => {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      return (issue.keys ?? []).map((key) => ({
        field: [...path, key].join('.'),
        location,
        message: requestMessages.unknownField,
      }));
    }
    return [{ field: path.length > 0 ? path.join('.') : rootField, location, message: issue.message }];
  });
}
