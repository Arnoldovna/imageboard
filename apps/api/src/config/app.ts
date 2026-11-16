/** Short, lowercase repository slug. Used for cookie names, Redis key prefixes and problem types. */
export const APP_SLUG = 'imageboard';

/** Fixed rate-limit windows (ADR 0013). The budgets per window come from the environment (`RATE_LIMIT_*`). */
export const RATE_LIMIT_WINDOWS_MS = {
  global: 5 * 60_000,
  media: 5 * 60_000,
  identities: 60 * 60_000,
  uploads: 60 * 60_000,
  uploadsGlobalDay: 24 * 60 * 60_000,
  comments: 10 * 60_000,
  deletes: 10 * 60_000,
} as const;

/**
 * Node HTTP server limits (ADR 0013). `headers` must not exceed `request`: Node's constructor rejects that, and a
 * larger value assigned later never fires because the request timeout ends the request first.
 */
export const HTTP_TIMEOUTS_MS = {
  request: 30_000,
  headers: 20_000,
} as const;

/** Readiness (ADR 0013): results are reused for `cacheMs`; each dependency check gets `checkTimeoutMs`. */
export const READINESS_MS = {
  cacheMs: 3_000,
  checkTimeoutMs: 2_000,
} as const;

/** Upper bound for closing connections and disposing clients once shutdown starts (after the drain delay). */
export const SHUTDOWN_FORCE_EXIT_MS = 10_000;
