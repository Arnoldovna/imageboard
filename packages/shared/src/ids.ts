import { z } from 'zod';

import { LIMITS } from './limits.js';
import { requestMessages } from './messages.js';

/**
 * Canonical decimal form of a positive id: no sign, no leading zero, no exponent, no fraction, at most 10 digits.
 * `"01"`, `"1e3"`, `"1.5"`, `"+1"` and `" 1"` are rejected before any number conversion (F-44, B-13).
 */
export const ID_PATTERN = /^[1-9]\d{0,9}$/;

/** A path id (`/api/images/:id`): a string in canonical form whose value fits a Postgres `integer`. */
export const IdParam = z
  .string({ error: requestMessages.invalidId })
  .regex(ID_PATTERN, { error: requestMessages.invalidId })
  .transform(Number)
  .pipe(z.number().int().positive().max(LIMITS.maxId, { error: requestMessages.invalidId }));
export type IdParam = z.output<typeof IdParam>;
