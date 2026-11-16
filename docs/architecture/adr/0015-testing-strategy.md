# ADR 0015: Testing strategy and test data isolation

- Status: proposed (revised after the architecture critique, round 1; aligned with conventions §6/§7 in the
  consistency-pass review, ADR 0021)
- Date: 15 Nov 2026
- Covers: all F-xx (mapping in OVERVIEW §15); B-86 and every regression test `B-xx`

## Context

The legacy project has no tests (B-86). PLAN.md fixes the tools: Vitest (unit), Supertest + Testcontainers (API),
Playwright + axe (E2E/a11y), all in `pnpm verify` and CI. The quality gate allows three fix attempts on red CI, so
any test that is red for reasons the PR did not cause (shared state between parallel files, rate limits, upstream
advisories) stops the autonomous run. Isolation therefore has to be designed, not hoped for.

The first draft shared one migrated database between all integration files (Vitest runs files in parallel by
default), truncated it in `beforeEach` and asserted exact counts; kept production rate-limit budgets in test apps;
and ran E2E against whatever stack was listening on port 8080, including the seeded dev stack. All three are fixed
below.

## Decision

| Layer             | Scope                                                                                                                                                                                                                   | Tooling                                                                                                                                                      | Data                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit `[U]`        | `packages/shared` schemas; API services (fakes for repository, storage, upload port, clock), cursor, problem mapping, env, logger redaction, sniffer, sharp processor; web stores, composables, HTTP client, components | Vitest 5.1 projects `unit:shared`, `unit:api`, `unit:web` (happy-dom 21, @testing-library/vue 8, user-event 14)                                              | in memory; sharp-generated fixtures                                                                                                                        |
| Integration `[A]` | Real Express app (`createTestApp`) with real Postgres 18 + Redis 8 from Testcontainers, fake `ObjectStorage`; one adapter test against a MinIO `GenericContainer` (Chainguard MinIO, digest from `test/images.ts`)      | Vitest project `integration:api` (`src/**/*.int.test.ts` **and** `test/**/*.int.test.ts`), Supertest 7.3 with `request.agent`                                | **one database per test file**, cloned from a migrated template by a setup file (below); a fresh Redis prefix per `createTestApp()`                        |
| E2E `[E]`         | User journeys and accessibility against the production images in an **isolated compose project**                                                                                                                        | Playwright 1.65 (desktop 1440×900 and mobile 390×844 on Chromium; WebKit smoke project), @axe-core/playwright 4.14 (WCAG 2.2 AA tags; serious/critical fail) | each test creates its own images through `e2e/support/api.ts` with unique titles; empty/error states via `page.route`; never count-based, never seed-based |

### Integration database isolation

Implements `project-scaffold/references/conventions.md` §7 verbatim (ADR 0021 §3):

- `test/global-setup.ts` starts one Postgres 18 and one Redis 8 container (images pinned by digest in
  `test/images.ts`, the same digests as compose). It creates database **`imageboard_template`**, runs the migrations
  against it, **closes every connection to it**, and provides `adminUrl` (the `postgres` database), `templateName`
  and `redisUrl` through `project.provide()`.
- `test/setup-database.ts` is registered in `vitest.integration.config.ts` `setupFiles`. For each test file it runs
  `CREATE DATABASE "t_<16 random hex>" TEMPLATE imageboard_template` over `adminUrl` in `beforeAll` and drops it
  with `DROP DATABASE … WITH (FORCE)` in `afterAll`. It publishes the URL through `currentDatabaseUrl()` from
  `test/test-db.ts`. Setup-file hooks run before the file's own `beforeAll`.
- `createTestApp()` (ADR 0017) uses `currentDatabaseUrl()` unless a `databaseUrl` is passed. Each test file builds
  its app(s) in `beforeAll`. Files that Vitest runs in parallel therefore never see each other's rows or identity
  sequences.
- **No `TRUNCATE`** (helper or inline). Inside one file the tests run sequentially and share the file's database. A
  test or `describe` block that needs a pristine state (exact first page, `nextCursor: null` with ≤ 12 rows, "after
  deleting id 1", keyset with interleaved insert/delete) calls `createTestDatabase()` → `{ url, drop }` (another
  clone of the template, tens of milliseconds) and passes `databaseUrl`. It then calls `drop()` after the app's
  `close()`.
- `createEmptyDatabase()` does the same without the template. `migrations.int.test.ts` uses it, migrates it twice
  and compares `drizzle.__drizzle_migrations` row counts (F-D1). It never touches the template.
- `seed.int.test.ts` runs in its file database, so its exact counts (16 images, 60 comments) are safe.
- `fileParallelism` stays on (default). Turning it off was considered (below) and rejected: once each file has its
  own database, it would make the integration job serial and add no isolation.

### Rate limits in tests

- `createTestApp` defaults every `RATE_LIMIT_*` variable to `100000`, so upload-heavy files (415 for
  svg/html/pdf/renamed, 413, unknown fields, compensation) never see a 429. It also gives each app a fresh Redis
  prefix `test-<uuid>`, built the same way the composition root builds `imageboard:` keys: sessions under
  `test-<uuid>:sess:` and limiters under `test-<uuid>:rl:<name>:`. Neither sessions nor counters leak between apps or
  files.
- Only `test/rate-limits.int.test.ts` passes small budgets (`createTestApp({ env: { RATE_LIMIT_UPLOADS: '2', … } })`)
  and asserts `429`, `Retry-After` and the problem body for each limiter, including the identity limiter and the
  global daily upload cap.

### E2E environment isolation

- E2E never runs against the dev stack. `scripts/run-e2e.mjs` (root script `pnpm test:e2e`) starts
  `docker compose -p imageboard-e2e -f docker-compose.yml -f docker-compose.e2e.yml --profile app up --build --wait`,
  sets `E2E_BASE_URL=http://127.0.0.1:${E2E_PORT:-8181}`, runs `playwright test` with the given arguments, writes
  `test-results/compose.log` when Playwright fails, and always runs `… down -v --remove-orphans` afterwards (unless
  `--keep`). `pnpm e2e:up` / `pnpm e2e:down` (`--up` / `--down`) expose the two halves for the phase-5 orchestrator;
  `--up` prints `E2E_BASE_URL` (contract: `project-scaffold/references/conventions.md` §6).
- `docker-compose.e2e.yml` (needs Compose ≥ 2.24.4 for `!reset` / `!override`):
  - removes host port publishing of postgres, redis and minio (`ports: !reset []`);
  - replaces their named volumes with tmpfs: `volumes: !reset []` plus `tmpfs: ['/var/lib/postgresql']` for
    postgres and `tmpfs: ['/data']` for minio;
  - **replaces** the web port with `ports: !override ['127.0.0.1:${E2E_PORT:-8181}:8080']`. Compose concatenates
    `ports` across files, so a plain entry would publish 8080 as well and collide with a running `pnpm demo` /
    `pnpm stack:up`;
  - sets every limiter in the API environment to `100000` (`RATE_LIMIT_GLOBAL`, `_MEDIA`, `_UPLOADS`,
    `_UPLOADS_GLOBAL_DAY`, `_COMMENTS`, `_DELETES`, `_IDENTITIES`). The base `docker-compose.yml` therefore needs no
    `RATE_LIMIT_*` passthrough.
- `run-e2e.mjs` resolves `E2E_PORT` once (process env, else the value in `.env`, else `8181`). It passes the value to
  the compose child process and builds `E2E_BASE_URL` from it, so the two can never disagree. It fails fast with a
  hint to run `pnpm setup:env` when `.env` is missing.
- In CI the `e2e` job runs on `pull_request` only (ADR 0020). Locally, `pnpm verify` always runs it.
- `playwright.config.ts` has **no `webServer`**, takes `baseURL` from `E2E_BASE_URL` (required; it fails fast when
  missing) and uses `retries: 0` locally and in CI; nothing can silently reuse a stack started with `pnpm stack:up`
  (port 8080) or `pnpm dev`. The e2e stack is never seeded.
- Test data: `e2e/support/api.ts` `createImageViaApi(page.request, …)` and `createCommentViaApi(page.request, …)`.
  `page.request` shares the browser context's cookie jar, so items created this way belong to the page's session and
  the UI may delete them; items created with a separate `request` context are "foreign" (for `canDelete: false`
  checks).
- "Load more" (F-04/F-05) in E2E: the test creates 13 images with a unique title prefix, then clicks "load more" until
  all 13 are visible and asserts no duplicate tiles. "Never shows load more with ≤ 12 images" is asserted with a
  `page.route` response (`nextCursor: null`) plus the API tests.

### Rules

- Every route: happy path, validation failure, CSRF missing, foreign origin, foreign owner (owned resources),
  unknown id, problem+json content type.
- Every BUGS item with a code fix has a test named `B-xx: <behaviour>` (traceability in OVERVIEW §17).
- No `.only`, no skipped tests, no weakened assertions or raised timeouts to get green (PLAN quality gate).
- Text rules share one vector file: `packages/shared/src/testing/text-vectors.ts` (exported as
  `@app/shared/testing`) lists accepted and rejected strings per field (limits, CRLF, C0/C1, U+2028/2029, bidi,
  Unicode whitespace). `text.test.ts` runs them through Zod; `db-constraints.int.test.ts` inserts the same strings
  directly and expects the same verdicts (ADR 0006).
- The index assertion for comments (B-40) runs `EXPLAIN (FORMAT JSON)` inside a transaction with
  `SET LOCAL enable_seqscan = off` and `SET LOCAL enable_bitmapscan = off`, and asserts an Index Scan on
  `comments_image_id_created_at_id_idx` **and no Sort node**, which proves the index serves filter and order. (On a
  tiny table the planner otherwise picks Seq Scan + Sort, which would make the assertion flaky.)
- CLS (F-09) is measured in `e2e/layout.spec.ts` with a `PerformanceObserver` for `layout-shift` after load and
  "load more" (< 0.1). Overflow is checked at 320, 390, 768, 1024, 1440 and 1920 px.
- Coverage is reported (`@vitest/coverage-v8`), not gated; services should be near 100 % branch coverage.
- Parallel build agents run only their own test paths (BUILD-ORDER ground rules); only the gate runs `pnpm verify`.
  Because the integration app imports every module, a unit swaps its stubbed `index.ts` last, after its unit tests
  pass (ADR 0021 §2).

## Alternatives

- **One shared database + `fileParallelism: false`**: simplest, and acceptable as an emergency fallback, but it
  serialises the slowest job and still leaves `migrations.int.test.ts` without an empty database. Rejected in favour
  of template clones (`CREATE DATABASE … TEMPLATE` takes tens of milliseconds).
- **A fresh clone per `createTestApp()` call and `TRUNCATE` inside a file** (revision 1): isolates as well, but
  conventions §7 fixes a setup file per test file and forbids `TRUNCATE`. Replaced in the consistency-pass review
  (ADR 0021).
- **Schema per file** instead of database per file: Drizzle migrations and the `drizzle` bookkeeping schema assume
  fixed schema names. Rejected.
- **MinIO for all integration tests**: slower and flakier than a fake; storage semantics are covered by the one
  adapter test plus the fake's contract (same interface).
- **Seeded DB for E2E**: brittle counts and order dependence across parallel workers. Rejected.
- **Mock Service Worker in web unit tests**: nice, but `vi.stubGlobal('fetch')` is enough for a single client.

## Consequences

- Docker is required for `pnpm test:integration` and `pnpm test:e2e` (local and CI ubuntu runners have it).
- The first integration run pulls images (hookTimeout 120 s).
- Compose ≥ 2.24.4 is required for `!reset` / `!override` in `docker-compose.e2e.yml` (CI runners and Docker
  Desktop ship newer; local Compose is 5.6.1).
- The e2e stack (`127.0.0.1:8181`) and the dev or demo stack (`127.0.0.1:8080`) can run at the same time.
- `pnpm verify` no longer writes anything into the dev database or bucket, so the seeded dev stack stays clean for
  the phase-4 design review and README screenshots.
