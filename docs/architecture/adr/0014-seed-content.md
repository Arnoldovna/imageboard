# ADR 0014: Seed content: openly licensed photographs, processed like uploads

- Status: proposed (revised after the architecture critique, round 1; seed guard and scripts amended in the
  consistency-pass review, ADR 0021)
- Date: 15 Nov 2026
- Covers: F-63, F-64; B-37, B-44

## Context

Legacy seeds point at a bootcamp bucket the project does not own (B-44). FEATURES F-63 requires ≥ 15 images (own or
openly licensed, licence noted) uploaded to local MinIO, with comments, idempotent. maw-design-system requires real,
project-specific content and bans lorem ipsum, fake names and generic stock or AI filler.

## Decision

- 16 photographs from **Lorem Picsum** (Unsplash photographs, Unsplash License), chosen by subject brief
  (DATA-MODEL §6.4), downloaded once by `src/scripts/fetch-seed-images.ts`, resized to ≤ 1600 px (JPEG q80,
  metadata stripped) and **committed** under `apps/api/seed/images/` with `manifest.json` and a generated
  `CREDITS.md` (photographer, Unsplash URL, Picsum id, licence). Attribution is given although the licence does not
  require it.
- Titles, descriptions, names and 60 comments are hand-written (DATA-MODEL §6.4–6.5) and adjusted to what each
  chosen photo shows. One image has 25 comments (pagination demo), one has none (empty state).
- `runSeed()` builds the upload module like the composition root and calls `port.ingest({ buffer, size },
{ objectKey })` with the fixed key from `manifest.json` (same sniff, sharp pipeline and preview as uploads, ADR 0017
  and 0018), then inserts the row and comments with fixed dates and a non-session owner id; rows whose key already
  exists are skipped (idempotent), unless their original or preview is missing in storage: then the file is ingested
  again under the same key and the row stays as it is, so a re-run repairs a reset storage volume. Runs only with an explicit `SEED_ALLOW=true`, which the `db:seed` script sets
  (cross-project seed guard, `project-scaffold/references/conventions.md` §8). The guard lives in the entry point
  `seed-cli.ts`, never in `runSeed()` (tests call it directly), and never looks at `NODE_ENV`. The seed only inserts,
  restores missing seed objects and skips, so there is no destructive reset to refuse. `SEED_ALLOW` is not an `.env` key.
- Scripts in `apps/api/package.json`, all with `tsx --conditions=development --env-file-if-exists=../../.env`:
  - `db:seed` (`SEED_ALLOW=true`, from phase 1a, where `seed-cli.ts` is a stub);
  - `db:seed:check` (`seed-cli.ts --check`: read-only, so no `SEED_ALLOW`; it verifies 16 rows, 60 comments and
    32 reachable objects and exits non-zero otherwise; added in phase 2.4);
  - `seed:fetch-images` (one-off, phase 2.4).
- `db:seed` runs from the host against compose services (ports on 127.0.0.1), for both `pnpm dev` and the
  `pnpm stack:up` stack. The API image does not contain seed files.

## Alternatives

- **Generated abstract placeholders** (flat maw colour fields rendered with sharp): fully self-owned and offline, but
  an image board full of colour squares looks fake and fails the maw "real content" rule. Kept as an emergency
  fallback only if the photo fetch is impossible in the build environment (then: 16 generated compositions, titles
  rewritten honestly, e.g. "Sky field, study 3", credits "generated").
- **Own photos by Marina**: best, but not available to an autonomous build; she can replace files later (same
  manifest format).
- **Hot-linking Picsum URLs**: third-party runtime dependency, the exact problem of B-44. Rejected.

## Consequences

- About 4 MB of JPEGs in the repo (acceptable; images never change).
- `seed.int.test.ts` runs `runSeed` twice with fake storage in its own database and asserts 16 images, 60 comments
  and 32 objects (originals + previews), and that a run after deleting objects of seeded rows stores them again
  without touching a row. The CI job `dev-setup-smoke` runs the real `pnpm dev:setup` (twice) against
  compose MinIO and checks the same numbers with `pnpm --filter @app/api db:seed:check` (OVERVIEW §16), because the seed powers the
  portfolio demo and must work outside the fake.
- README screenshots are reproducible (fixed dates and content).
