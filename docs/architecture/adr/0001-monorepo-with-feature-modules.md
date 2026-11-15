# ADR 0001: pnpm monorepo with feature modules and a Zod contract package

- Status: proposed (consequence on CI triggers amended in the consistency-pass review, ADR 0020)
- Date: 15 Nov 2026
- Covers: PLAN "Struktur", "Shared"; B-16, B-27, B-50, B-61

## Context

The legacy app is one Express file plus a global-script Vue 2 page with hand-vendored libraries (B-16, B-61).
Response shapes are ad hoc (B-27) and logic is copy-pasted (B-50). PLAN.md fixes the target: a pnpm monorepo for
Imageboard with `apps/web` (Vue 3), `apps/api` (Express 5) and `packages/shared` (Zod), feature modules with ESLint
import boundaries, and the `project-scaffold` templates as the starting point.

## Decision

- Workspace `apps/*`, `packages/*` with pnpm 10.34.9; internal scope `@app/*` (`@app/web`, `@app/api`,
  `@app/shared`). Staying on the pnpm 10 line is a **deliberate project choice**, not a PLAN requirement (PLAN.md
  says only "pnpm"): the `project-scaffold` templates (`onlyBuiltDependencies`, `minimumReleaseAge`,
  `injectWorkspacePackages`, `pnpm deploy`) are verified against 10.34.9, while 12.x is `latest`. Moving to 12 is a
  separate, verified change later. `.npmrc` sets `engine-strict=true` so a wrong Node version fails the install
  instead of warning.
- Backend features `images`, `comments`, `upload`, plus `session`; layered `routes → controller → service →
  repository`. Features never import each other; the composition root (`app.ts`) injects ports
  (`ImageUploadPort`, `imageExists`, the multipart parser, limiters; exact types in ADR 0017). This is stricter than the skill default (index-only imports) because it keeps
  every backend module buildable in parallel and testable with fakes.
- Frontend features `gallery`, `image-detail`, `comments`, `upload`, plus `app/` (shell, router, pages) and
  `shared/` (HTTP client, session store, announcer, UI primitives). One allowed cross-feature edge:
  `image-detail → comments/index.ts` (the comments section lives inside the dialog). Everything else is coordinated
  by `app/pages/HomePage.vue`.
- `packages/shared` contains only Zod schemas, limits and user-facing messages. It is the single API contract.
- `eslint-plugin-boundaries` enforces the rules (`default: 'disallow'`); elements `feature`, `shared`, `config`,
  `db`, plus `scripts` (api) and `app` (web).

## Alternatives

- **Separate repos for web and API**: contract drift, two CI pipelines, no shared types. Rejected.
- **Layer-first folders (`controllers/`, `services/`)**: changes to one feature touch many folders; no natural
  boundary to lint. Rejected (PLAN mandates feature modules).
- **OpenAPI generation instead of Zod sharing**: more tooling for a small API; Zod gives runtime validation on both
  sides for free. Could be added later with `zod-openapi` from the same schemas.

## Consequences

- One `pnpm verify` runs everything; CI jobs map 1:1 to its steps (the `e2e` job runs on pull requests only, ADR
  0020; locally `pnpm verify` always includes it).
- Contract changes are compile errors in both apps.
- Parallel module builds are possible because contracts, DB schema and module entry points exist before the modules
  (ADR 0017).
- Slight indirection: cross-feature behaviour is visible only in `app.ts` (API) and `HomePage.vue` (web), which is
  the intended single place to read the wiring.
