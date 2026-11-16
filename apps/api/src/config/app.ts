/** Short, lowercase repository slug. Used for cookie names, Redis key prefixes and problem types. */
export const APP_SLUG = 'imageboard';

/**
 * App-scoped cookie name (conventions §8, ADR 0021 §7): cookies ignore ports and all three projects run on 127.0.0.1.
 * `__Host-imageboard.<name>` when Secure, else `imageboard.<name>`.
 */
export function appCookieName(name: string, secure: boolean): string {
  return `${secure ? '__Host-' : ''}${APP_SLUG}.${name}`;
}

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

/**
 * S3 client limits per attempt (the SDK makes up to 3 attempts). `connect`: TCP/TLS connect. `request`: until the
 * response headers arrive, a PutObject body upload (≤ 5 MiB) included. Without `request`, an endpoint that accepts the
 * connection and then stalls would hold an upload or delete request open forever. With it, even the object cleanup of
 * a delete (3 attempts per key, ADR 0008) ends in under a minute against a stalled endpoint, inside nginx's default
 * 60 s proxy timeout. A streamed media body is not limited by it: the timer stops at the response headers, and a
 * client that goes away ends the stream.
 */
export const S3_TIMEOUTS_MS = {
  connect: 3_000,
  request: 5_000,
} as const;

/** Upper bound for closing connections and disposing clients once shutdown starts (after the drain delay). */
export const SHUTDOWN_FORCE_EXIT_MS = 10_000;
