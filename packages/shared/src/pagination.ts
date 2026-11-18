import { z } from 'zod';

import { LIMITS } from './limits.js';
import { requestMessages } from './messages.js';

/**
 * Opaque keyset cursor as the client sees it (ADR 0007). The API decodes it; any decoding failure is
 * `400 invalid-cursor`. Over-long values are rejected here, before anything is decoded.
 */
export const Cursor = z
  .string({ error: requestMessages.invalidCursor })
  .min(1, { error: requestMessages.invalidCursor })
  .max(LIMITS.cursorMaxLength, { error: requestMessages.invalidCursor });
export type Cursor = z.infer<typeof Cursor>;

/**
 * What an opaque cursor decodes to (ADR 0007): the keyset position `{ t, id }` of the last item the client has seen,
 * base64url-encoded JSON. `t` has millisecond precision like `timestamptz(3)`, so the position round-trips exactly.
 * Year 0000 is valid ISO 8601 but not a Postgres timestamp, so it is refused here instead of failing the query.
 * Shared by the API and the live demo's in-browser API, so both accept and refuse exactly the same cursors.
 */
export const CursorPayload = z.strictObject({
  t: z.iso.datetime({ precision: 3 }).refine((value) => !value.startsWith('0000-')),
  id: z.number().int().positive().max(LIMITS.maxId),
});
export type CursorPayload = z.infer<typeof CursorPayload>;

const INTEGER = /^-?\d+$/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `?limit=&cursor=` (API.md §0): an empty or missing `limit` means `defaultLimit`; a non-integer is a 400; an integer
 * out of range is clamped to 1..`max` (F-02: larger values are capped, not rejected). An empty `cursor` means
 * "first page". Unknown query keys are rejected (strict request schemas).
 */
export function pageQuery(defaultLimit: number, max: number) {
  return z.strictObject({
    limit: z
      .string({ error: requestMessages.invalidLimit })
      .refine((raw) => raw === '' || INTEGER.test(raw), { error: requestMessages.invalidLimit })
      .optional()
      .transform((raw) => (raw === undefined || raw === '' ? defaultLimit : clamp(Number(raw), 1, max))),
    cursor: z
      .union([z.literal(''), Cursor], { error: requestMessages.invalidCursor })
      .optional()
      .transform((raw) => (raw === '' ? undefined : raw)),
  });
}
export type PageQuery = z.output<ReturnType<typeof pageQuery>>;

/** Response page: `{ items, nextCursor }`, where `nextCursor` is null when no older item exists (B-46). */
export function pageOf<Item extends z.ZodType>(item: Item) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
