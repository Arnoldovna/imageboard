import { z } from 'zod';

/** Readiness states of `GET /api/health` (API.md §5). */
export const HealthStatus = z.enum(['ok', 'unavailable', 'shutting-down']);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** Response body of `GET /api/health` and `GET /api/health/live`. Tolerant reader: unknown keys are ignored. */
export const HealthDto = z.object({ status: HealthStatus });
export type HealthDto = z.infer<typeof HealthDto>;
