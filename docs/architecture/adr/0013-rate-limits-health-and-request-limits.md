# ADR 0013: Rate limits, request size limits and health endpoints

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-40, F-47, F-49; B-09, B-87

## Context

No abuse protection exists in the legacy app (B-09), and there is no health check or graceful shutdown (B-87).
FEATURES fixes budgets (uploads 10/h, comments 20/10 min, deletes 30/10 min, everything else 300/5 min), a 16 KB JSON
limit and `GET /api/health`. The scaffold template mounts health at `/health/{live,ready}` and uses 100 KB bodies.

## Decision

**Rate limits** (express-rate-limit 8.7 + rate-limit-redis 6, per IP, `ipv6Subnet: 56`, `standardHeaders:
'draft-8'`, handler → `429 rate-limited` problem; `Retry-After` set by the library):

| Limiter              | Window (code constant) | Limit (env)                           | Key                | Applies to                                                                                          |
| -------------------- | ---------------------- | ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `global`             | 5 min                  | `RATE_LIMIT_GLOBAL` = 300             | IP                 | every `/api/*` request, before body parsing and the session middleware (not health, not media)      |
| `media`              | 5 min                  | `RATE_LIMIT_MEDIA` = 1200             | IP                 | `/api/media/*` (a page load fetches 12 to 24 previews, so the global budget would be far too small) |
| `identities`         | 1 h                    | `RATE_LIMIT_IDENTITIES` = 20          | IP                 | `GET /api/session`, counted **only** when a new `ownerId` is created (ADR 0002)                     |
| `uploads`            | 1 h                    | `RATE_LIMIT_UPLOADS` = 10             | IP                 | `POST /api/images`                                                                                  |
| `uploads-global-day` | 24 h                   | `RATE_LIMIT_UPLOADS_GLOBAL_DAY` = 200 | constant key `all` | `POST /api/images` from all clients together (storage-cost cap against distributed abuse, ADR 0019) |
| `comments`           | 10 min                 | `RATE_LIMIT_COMMENTS` = 20            | IP                 | `POST /api/images/:imageId/comments`                                                                |
| `deletes`            | 10 min                 | `RATE_LIMIT_DELETES` = 30             | IP                 | `DELETE /api/images/:id` and `DELETE /api/comments/:id` (one shared instance)                       |

The `media` and `identities` limiters and the global daily upload cap are additions to FEATURES F-40; `/api/health`
has no limiter because it is not reachable from outside (below). F-40 is annotated accordingly.

Each limiter has its own Redis prefix `imageboard:rl:<name>:`. Limiter instances are created in `app.ts` and passed
into modules (ADR 0017). Limiter stores use `RATE_LIMIT_REDIS_URL` when set (ADR 0002). Correct client IPs depend
on `TRUST_PROXY` = the exact number of proxies in front of the API (1 behind nginx; 2 behind a platform load
balancer + nginx).

**Request limits**: `express.json({ limit: '16kb', strict: true })`; no urlencoded parser; `requireJson` (415) on
JSON routes; multipart limits in ADR 0005 (`fieldSize` 16 KiB); Node `requestTimeout = 30_000` and
`headersTimeout = 20_000`, passed to `http.createServer()` (`config/app.ts` `HTTP_TIMEOUTS_MS`). `headersTimeout` must
not exceed `requestTimeout`: Node's constructor rejects that, and a larger value assigned later never fires because the
request timeout ends the request first (the template's `65_000` was inert). The global limiter runs **before**
`express.json`, so a malformed or oversized JSON body, which ends the chain with `next(err)`, is still counted, and an
over-budget client is rejected before its body is read. nginx's `client_max_body_size` for `/api/` comes from the environment
(`API_MAX_BODY_SIZE`, default `6m`, rendered by the nginx image's `/etc/nginx/templates` envsubst step) and must stay
slightly above `UPLOAD_MAX_BYTES` so the API, not nginx, produces the 413 problem. `env.ts` caps
`UPLOAD_MAX_BYTES` at 20 MiB (memory buffers). If nginx still answers with its own HTML 413 or a 502/504, the web
client maps the non-problem body to `ApiError { code: 'unexpected-response', status }` (ADR 0010).

**Health**: `GET /api/health` = readiness (DB `select 1`, Redis `isReady`, S3 `HeadBucket`, 2 s timeout each; 503
while shutting down), `GET /api/health/live` = liveness. Mounted before helmet/session/limits, not logged on
success. The checks bound themselves to the same 2 s (`query_timeout` on the ping, an `AbortSignal` on `HeadBucket`;
pg's `connectionTimeoutMillis` 5 s, S3 `connectionTimeout` 3 s), because the router's timeout only stops waiting: an
unbounded check would leave one hanging call per cache window while a dependency hangs.

- The readiness result is **cached for 3 s with a single in-flight check**: concurrent callers share one promise, so
  at most one `select 1`, one Redis check and one (billable on AWS) `HeadBucket` run per 3 s, whoever calls.
  Shutdown state bypasses the cache (503 immediately).
- nginx **denies** `location ~* ^/api/health(?:/|$)` (`return 404`) for external callers, in any letter case; the
  API routes case-sensitively (`case sensitive routing` for the mount paths, `Router({ caseSensitive: true })` inside
  every router), so `/api/HEALTH` is a plain 404 there too (phase 5 security audit: a case-sensitive `^~` prefix let
  `/api/HEALTH` through to Express). The compose healthcheck calls the
  api container directly (`node -e "fetch('http://127.0.0.1:3000/api/health')…"`, no curl in distroless), and
  `docker compose up --wait` waits on it; Playwright needs no health URL (ADR 0015). A platform load balancer must
  probe the api container, not the public origin.

**Shutdown** (`shared/http/graceful-shutdown.ts`, wired in `server.ts`): SIGTERM/SIGINT → readiness 503 → wait
`SHUTDOWN_DELAY_MS` (default 0; behind a load balancer at least its probe interval × unhealthy threshold, so it stops
routing while the API still accepts connections) → `server.close()` (closes idle keep-alive connections; in-flight
requests finish) → `container.dispose()` (pool end, Redis close, S3 destroy) → exit 0. A 10 s unref'd timer after the
delay forces exit 1. `unhandledRejection`, `uncaughtException` and a failed `listen` log `fatal`, skip (or cut short)
the delay and run the same sequence, but exit **1**, so a supervisor sees a crash and restarts (ADR 0009). The pg
pool and both Redis clients have `error` listeners (`createDatabase`, `connectRedis`): an `error` event without one
would be thrown and end the process.

## Alternatives

- **Limits in nginx (`limit_req`)**: works only in the Docker deployment, not in tests or other hosts, and cannot
  return problem+json. Rejected as the primary mechanism.
- **In-memory limiter stores**: reset on restart and wrong with more than one instance; used only in unit tests.
- **Keep `/health/*` paths**: FEATURES explicitly names `/api/health`; one prefix also keeps nginx simpler.
- **A lenient limiter on a public health route** instead of denying it at nginx: still lets anyone trigger backend
  work up to the budget; the cache plus the deny is cheaper and simpler.
- **Hard-code `client_max_body_size 6m` and cap `UPLOAD_MAX_BYTES` at 5 MiB**: avoids the template, but then the
  "configurable" upload limit is not configurable without editing nginx. Rejected.

## Consequences

- E2E needs many requests from one IP: `docker-compose.e2e.yml` sets every limiter to 100000 for the isolated e2e
  project only (ADR 0015). Production keeps the defaults. `rate-limits.int.test.ts` proves the 429 path with tiny
  limits for every limiter.
- Shared NAT users share budgets; acceptable for this product.
- `health.int.test.ts` covers 200, 503 on each failing check, 503 while shutting down, and that two calls within
  3 s run the checks once.
