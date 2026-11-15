# ADR 0021: Alignment with the cross-project consistency pass

- Status: proposed (added in the consistency-pass review, 16 Nov 2026)
- Date: 16 Nov 2026
- Covers: conventions §1, §3 to §9 as applied to imageboard; B-33, B-37, B-86; F-63, F-64

## Context

The consistency pass of 15 Nov 2026 (`project-scaffold/references/conventions.md`) changed rules shared by all
three projects after the architecture critique of this project:

- the parallel model (all units in one working tree);
- integration-test isolation (one database per test file, created by a setup file);
- isolated e2e stacks with their own ports;
- app-scoped cookie names;
- the `SEED_ALLOW` switch;
- CI and release workflows.

PLAN.md Etappe 0 also now says the machine prerequisites are done through `~/Code/.devenv.sh`, with no system
changes. An adversarial re-review of these docs found steps that contradicted the new rules or could not be built as
written. Each fix is listed below. CI cost rules are in ADR 0020.

## Decision

1. **Phase 0 is `/Users/marina/Code/.devenv.sh`.** The script prepends `~/.local/node/current/bin` (Node 26.13.1,
   checksum-verified) and `/usr/bin` (Apple Git 2.50, ahead of the old `/usr/local/bin/git` 2.23). It exports
   `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. pnpm in that Node's `bin` is a corepack shim, and corepack runs exactly the
   version in `package.json#packageManager` (`pnpm@10.34.9`). Every shell command an agent runs starts with
   `source /Users/marina/Code/.devenv.sh && `. Do not install fnm or brew git, do not run `npm i -g pnpm`, and do not
   edit shell rc files. PLAN.md wins over conventions §1, which still describes fnm. The orchestrator installs
   Playwright's browsers once in 1a (`pnpm exec playwright install chromium webkit`, no `--with-deps` on macOS),
   because that needs the Playwright version from the lockfile.
2. **One working tree, importable at all times.** The API integration tests build the whole app (`app.ts` imports
   every module's `index.ts`). The web component tests render real child components. So a sibling's half-finished
   module could turn every unit's scoped tests red. Rules:
   - A unit writes its internal files first. It swaps its `index.ts` from the stub body to the real implementation
     **last**, after its internal files are complete and its unit tests pass. Its integration tests then run through
     the swapped `index.ts`, which must never throw at import or at `create*Module()` time.
   - Every file a unit saves must parse.
   - A test that renders another feature's public component stubs it (`global: { stubs: { CommentsSection: true } }`
     in `ImageDetailDialog.test.ts`).
   - A failure caused by a sibling's file is reported, never fixed by the unit.
   - "Frozen" (conventions §4) applies to parallel units. The sequential steps 2.4, 4.1, 4.3, 5.2 and 5.3 run between
     waves under the orchestrator and may edit exactly the frozen files that BUILD-ORDER lists for them.
3. **Integration isolation as in conventions §7, without the first draft's variant.**
   - `test/global-setup.ts` migrates the template database **`imageboard_template`** and closes its connections.
   - `test/setup-database.ts` (Vitest `setupFiles`) clones `t_<random hex>` from it in `beforeAll` and drops it
     `WITH (FORCE)` in `afterAll`.
   - `createTestApp()` uses that file database by default.
   - When a `describe` block needs a pristine database in addition to the file's own (exact pages, "after deleting
     id 1"), it calls `createTestDatabase()` → `{ url, drop }` and passes `databaseUrl`.
   - There is **no `TRUNCATE`** anywhere.
   - Each `createTestApp()` call gets a fresh Redis prefix `test-<uuid>`. Sessions use `test-<uuid>:sess:`, limiters
     `test-<uuid>:rl:<name>:`, the same shape the composition root builds from `APP_SLUG`.
   - Testcontainers images, MinIO included, come from the digests in `test/images.ts`.
4. **The e2e override really isolates.**
   - Compose concatenates `ports` across files. A plain `web.ports` entry in `docker-compose.e2e.yml` would therefore
     publish 8080 **and** 8181, and the e2e stack would collide with a running `pnpm demo`. The override uses
     `ports: !override ['127.0.0.1:${E2E_PORT:-8181}:8080']` for `web` and `ports: !reset []` for postgres, redis and
     minio.
   - Data: `volumes: !reset []` plus `tmpfs: ['/var/lib/postgresql']` (postgres) and `tmpfs: ['/data']` (minio).
   - Requires Compose ≥ 2.24.4. The Compose merge reference lists it for these tags. Local is 5.6.1.
   - `scripts/run-e2e.mjs` resolves `E2E_PORT` once (process env, else `.env`, else `8181`). It passes the value
     both to the compose child process and to `E2E_BASE_URL`, so a port set only in `.env` cannot split them.
   - The template's CI steps "Stack logs" and "Tear down" target the dev project and are removed. `run-e2e.mjs`
     writes `test-results/compose.log` and always runs `down -v`.
5. **The seed guard lives in the entry point, and the scripts exist from 1a.**
   - `apps/api` script `db:seed` = `SEED_ALLOW=true tsx --conditions=development --env-file-if-exists=../../.env
     src/scripts/seed-cli.ts` from phase 1a (the stub refuses without it, so `dev:setup` would fail otherwise).
   - `seed-cli.ts` checks `SEED_ALLOW === 'true'` and never `NODE_ENV`. `runSeed()` has no guard, because tests call
     it directly with their own database and fake storage.
   - `--check` is read-only and needs no `SEED_ALLOW`. It runs as the `db:seed:check` script (same `tsx` flags; a
     bare `tsx seed-cli.ts` has neither `.env` nor the `development` condition, so `@app/shared` would resolve to a
     `dist/` the CI job never built).
   - The seed only inserts and skips existing keys, so there is no destructive reset to refuse.
   - `SEED_ALLOW` is not an `.env` key and is not in `.env.example`.
   - `admin:remove-image` uses the same `tsx` flags.
6. **`db:generate` builds the contract first.** The Drizzle schema imports `@app/shared` (CHECK constants).
   drizzle-kit loads schema files with its own loader, which does not apply the `development` export condition, so
   the package must resolve to `dist/`. `apps/api` `db:generate` = `pnpm --filter @app/shared build && drizzle-kit
   generate`. The CI drift step calls that script (`pnpm --filter @app/api db:generate`). Phase 1b verifies this. If
   drizzle-kit is shown to resolve the source, the build step may be dropped, with a note in this ADR.
7. **Cookie names are app-scoped in both modes.**
   - Session: `__Host-imageboard.sid` (secure) or `imageboard.sid` (local http).
   - CSRF: `__Host-imageboard.x-csrf-token` or `imageboard.x-csrf-token`.
   - All Redis keys start with `imageboard:`, or `test-<uuid>:` in integration tests.
8. **Phase-5 units add `--workers=2`** to their Playwright command. Seven units share one machine and one stack, and
   the default worker count per unit would oversubscribe it. Only the orchestrator starts, rebuilds or stops a stack:
   `pnpm demo` / `pnpm stack:down` around 4.3, and `pnpm e2e:up` / `pnpm e2e:down` around 5.1.
9. **Docs are formatted, not ignored.** The template's `.prettierignore` covers only `docs/media`, so
   `pnpm format:check` (the first `verify` step) checks `docs/**/*.md`. The docs as committed fail it (21 files on
   16 Nov 2026). Phase 1a runs `pnpm format` once, which changes layout only (table padding, blank lines, `_x_`
   emphasis). lint-staged (`*.md` → `prettier --write`) keeps later edits formatted. No `.prettierignore` delta.

## Alternatives

- **Keep a fresh clone per `createTestApp()` call and allow `TRUNCATE` inside a file** (the first draft): it
  isolates as well, but it re-decides conventions §7, which forbids it ("not re-decided per project"). Rejected.
- **Git worktrees or one branch per unit**: avoids the importability rules, but conventions §4 fixes one working
  tree. Rejected.
- **fnm and Homebrew git** as in conventions §1: PLAN.md records Phase 0 as done through `.devenv.sh` without system
  changes. Rejected.
- **`E2E_PORT` only from the process environment**: silent mismatch when someone sets it in `.env`. Rejected.
- **Avoid `@app/shared` in the Drizzle schema** (duplicate the constants): two sources for the same limits and
  character classes, which is exactly B-43. Rejected.

## Consequences

- The integration test harness gains one file (`test/setup-database.ts`). `TestAppOptions` keeps its shape (ADR
  0017). Only the default and the meaning of `close()` change: it closes the pool and Redis, and the setup file drops
  the database.
- The local `pnpm verify` and the phase-4 demo stack can run at the same time (8080 and 8181).
- Conventions §1 (fnm) and §9 (no CI cost rule) are stale against PLAN.md and ADR 0020. Marina should update the
  shared file and the two other projects (listed in the review report). Imageboard follows PLAN.md and these ADRs
  meanwhile.
