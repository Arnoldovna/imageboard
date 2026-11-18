# ADR 0014: Seed content: original artwork generated in code, processed like uploads

- Status: proposed (revised after the architecture critique, round 1; seed guard and scripts amended in the
  consistency-pass review, ADR 0021; revised 18 Nov 2026: the Unsplash photographs were replaced by original
  artwork in an Art Nouveau / Art Deco direction generated in the repository, see "Alternatives")
- Date: 15 Nov 2026, revised 18 Nov 2026
- Covers: F-63, F-64; B-37, B-44

## Context

Legacy seeds point at a bootcamp bucket the project does not own (B-44). FEATURES F-63 requires ≥ 15 images (own or
openly licensed, licence noted) uploaded to local MinIO, with comments, idempotent. maw-design-system requires real,
project-specific content and bans lorem ipsum, fake names and generic stock or AI filler.

## Decision

- 16 **original illustrations** inspired by Art Nouveau (Jugendstil) and Art Deco in general: botanical motifs on a
  strict vertical axis (iris, tulip, lotus, whiplash stems), repeat patterns and friezes, framed medallions, thin
  line drawing, and Deco geometry (sunbursts, ziggurats, fans, thin gold on black), plus a few radically reduced bold
  graphics (a mirror-symmetric black ink form on red-orange). Palette: paper, sand, petrol, olive, coral, red-orange,
  violet, mustard, black; matte, with a light paper grain on every piece, no gradients, glow or 3D. Each piece is SVG
  composed in TypeScript (`src/scripts/seed-art/pieces.ts`, helpers in `seed-art/svg.ts`) with its own seeded random
  source; `src/scripts/generate-seed-art.ts` (`pnpm --filter @app/api seed:generate-art`) renders them with sharp
  (librsvg) to JPEG (long edge 1600 px, q82, no metadata) and writes them, **committed**, to `apps/api/seed/images/`
  together with a generated `CREDITS.md`. `manifest.json` maps each slug to its fixed object key. Portrait,
  landscape and square formats are mixed so the gallery shows variety. No downloads, no tracing or copying of existing
  works, posters, logos or a named artist's style (the moodboard Marina shared sets a direction only), no AI image
  service, no text in the pictures.
- The artwork is part of the repository and licensed with it (MIT, like the code). `CREDITS.md` and the README say so.
- Titles, descriptions, names and 60 comments are hand-written (DATA-MODEL §6.4–6.5) and fit each picture: the
  fiction is people sharing their own illustrations and prints. One image has 25 comments (pagination demo), one has
  none (empty state).
- `runSeed()` builds the upload module like the composition root and calls `port.ingest({ buffer, size },
{ objectKey })` with the fixed key from `manifest.json` (same sniff, sharp pipeline and preview as uploads, ADR 0017
  and 0018), then inserts the row and comments with fixed dates and a non-session owner id; rows whose key already
  exists are skipped (idempotent), unless their original or preview is missing in storage: then the file is ingested
  again under the same key and the row stays as it is, so a re-run repairs a reset storage volume. Runs only with an explicit `SEED_ALLOW=true`, which the `db:seed` script sets
  (cross-project seed guard, `project-scaffold/references/conventions.md` §8). The guard lives in the entry point
  `seed-cli.ts`, never in `runSeed()` (tests call it directly), and never looks at `NODE_ENV`. The seed inserts,
  restores missing seed objects and skips. Last, after every manifest picture is in place, it retires the images of
  an earlier seed version (seed owner, key no longer in the manifest) in one `DELETE … RETURNING`, then discards
  their objects (row first, ADR 0008). Like any deleted image, a retired one takes its comments with it, visitors'
  comments included; visitors' own images are never touched. A run that fails on a new picture leaves the old seed in
  place. `db:seed:check` reports a retired row that is still there. Running an older checkout's `db:seed` against a
  newer seed retires the newer one the same way, which is the intended "the manifest is the truth". There is no reset to refuse. `SEED_ALLOW` is not an `.env` key.
- Scripts in `apps/api/package.json`, all with `tsx --conditions=development --env-file-if-exists=../../.env`:
  - `db:seed` (`SEED_ALLOW=true`, from phase 1a, where `seed-cli.ts` is a stub);
  - `db:seed:check` (`seed-cli.ts --check`: read-only, so no `SEED_ALLOW`; it verifies 16 rows, 60 comments and
    32 reachable objects and exits non-zero otherwise; added in phase 2.4);
  - `seed:generate-art` (redraws the pictures; needs no env and no network).
- `db:seed` runs from the host against compose services (ports on 127.0.0.1), for both `pnpm dev` and the
  `pnpm stack:up` stack. The API image does not contain seed files.

## Alternatives

- **Openly licensed photographs (Lorem Picsum / Unsplash)**: the first version of this ADR. Real-looking, but
  third-party content in a public repository, a credits list of sixteen photographers, and a gallery that looked like
  any stock demo. Replaced on Marina's request ("Art-Deco-Illustrationen oder moderne Interpretationen davon und bold
  graphics").
- **Generated flat colour placeholders**: self-owned and offline, but colour squares look fake. The artwork keeps the
  same advantages and is meant to be looked at.
- **AI image services**: unclear licence and the generic look maw-design-system bans. Rejected.
- **Own pictures by Marina**: she can replace files later (same slug, same manifest format).
- **Hot-linking any third-party URL**: runtime dependency, the exact problem of B-44. Rejected.

## Consequences

- About 2 MB of JPEGs in the repo. Regenerating with the same sharp/libvips version gives byte-identical files;
  `generate-seed-art.test.ts` checks the committed files' sizes, that they carry no metadata, that the SVG is
  self-contained (no text, images or links) and that `CREDITS.md` matches the generator.
- New object keys came with the new pictures. `db:seed` retires the old seed rows on its next run (see Decision). The
  Pages demo stores a fingerprint of its seed in IndexedDB and replaces a stored seed with a different one (the
  visitor's own uploads go with it, as with "reset demo"); the other open tabs are told to reload.
- `seed.int.test.ts` runs `runSeed` twice with fake storage in its own database and asserts 16 images, 60 comments
  and 32 objects (originals + previews), and that a run after deleting objects of seeded rows stores them again
  without touching a row. The CI job `dev-setup-smoke` runs the real `pnpm dev:setup` (twice) against
  compose MinIO and checks the same numbers with `pnpm --filter @app/api db:seed:check` (OVERVIEW §16), because the seed powers the
  portfolio demo and must work outside the fake.
- README screenshots are reproducible (fixed dates and content).
