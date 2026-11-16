import type { HealthDto } from '@app/shared';
import { Router, type Response } from 'express';

import { READINESS_MS } from '../../config/app.js';

/**
 * Resolves true when a dependency is reachable. A rejection or a timeout counts as "not ready". The check itself must
 * also give up after `READINESS_MS.checkTimeoutMs`: the timeout below only stops waiting, so an unbounded check would
 * pile up one hanging call per cache window while a dependency hangs.
 */
export type ReadinessCheck = () => Promise<boolean>;

export interface HealthRouterOptions {
  checks: Readonly<Record<string, ReadinessCheck>>;
  isShuttingDown: () => boolean;
  /** How long a readiness result is reused (ADR 0013: 3 s). */
  cacheMs?: number;
  /** Per-check timeout (ADR 0013: 2 s). */
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  const result = Promise.resolve()
    .then(check)
    .catch(() => false);
  return Promise.race([result, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Readiness with a short cache and a single in-flight run: concurrent callers share one promise, so at most one
 * `select 1`, one Redis check and one (billable) S3 `HeadBucket` run per cache window, whoever calls.
 */
export function createReadiness(
  checks: Readonly<Record<string, ReadinessCheck>>,
  {
    cacheMs = READINESS_MS.cacheMs,
    timeoutMs = READINESS_MS.checkTimeoutMs,
    now = Date.now,
  }: Pick<HealthRouterOptions, 'cacheMs' | 'timeoutMs' | 'now'> = {},
): () => Promise<boolean> {
  let cached: { ok: boolean; at: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  return () => {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.ok);
    inFlight ??= Promise.all(Object.values(checks).map((check) => withTimeout(check, timeoutMs)))
      .then((results) => {
        const ok = results.every(Boolean);
        cached = { ok, at: now() };
        return ok;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

function send(res: Response, status: number, body: HealthDto): void {
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

/**
 * Mounted at `/api/health` before helmet, sessions and rate limits (ADR 0013). Internal only: nginx answers 404 for
 * `/api/health*`, so the compose healthcheck and load balancers probe the api container directly.
 *   GET /api/health       readiness (DB, Redis, S3), 503 while a check fails or the server shuts down
 *   GET /api/health/live  liveness, 200 while the process runs
 * The body never names the failing dependency.
 */
export function createHealthRouter({ checks, isShuttingDown, ...options }: HealthRouterOptions): Router {
  const isReady = createReadiness(checks, options);
  const router = Router();

  router.get('/live', (_req, res) => {
    send(res, 200, { status: 'ok' });
  });

  router.get('/', async (_req, res) => {
    // Shutdown bypasses the cache: the load balancer must stop routing immediately.
    if (isShuttingDown()) {
      send(res, 503, { status: 'shutting-down' });
      return;
    }
    const ok = await isReady();
    send(res, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable' });
  });

  return router;
}
