import { z } from 'zod';

/**
 * `GET /api/session` (API.md §1): the CSRF token for this session (kept in memory by the SPA, sent as
 * `x-csrf-token`) and the effective upload limit for the client-side size check (F-20).
 */
export const SessionDto = z.object({
  csrfToken: z.string().min(1),
  uploadMaxBytes: z.number().int().positive(),
});
export type SessionDto = z.infer<typeof SessionDto>;
