# imageboard

A public, account-less image board: upload an image with a title and description, browse the gallery newest first,
open an image, comment on it, and delete what you uploaded or wrote. A rebuild of my 2018 bootcamp project as a
pnpm monorepo (Vue 3, Express 5, PostgreSQL, Redis, S3).

> Work in progress. This README is a stub; screenshots, the architecture diagram and the write-up follow when the
> app is complete.

## Getting started

Requirements: Node 26 (`.nvmrc`), pnpm 10.34.9 (`packageManager`), Docker with Compose 2.24.4 or newer.

Try it (production images, http://127.0.0.1:8080):

```bash
pnpm install
pnpm demo
```

Develop (API on :3000, Vite on :5173):

```bash
pnpm install
pnpm dev:setup
pnpm dev
```

`pnpm dev:setup` creates `.env` with random local secrets (it never overwrites existing values), starts Postgres,
Redis and MinIO, runs the migrations and seeds the database. Running it again changes nothing.

## Scripts

| Script                                        | What it does                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm verify`                                 | format check, lint, stylelint, utility-class check, typecheck, all tests, build, gitleaks |
| `pnpm test` / `test:integration` / `test:e2e` | Vitest unit tests / Supertest + Testcontainers / Playwright against the production images |
| `pnpm stack:up` / `stack:down`                | production images on http://127.0.0.1:8080                                                |

## Fonts

Schibsted Grotesk by the Schibsted Grotesk Project Authors — SIL Open Font License 1.1 (see
[LICENSES/OFL-SchibstedGrotesk.txt](LICENSES/OFL-SchibstedGrotesk.txt)). Self-hosted via @fontsource.

## Licence

[MIT](LICENSE) © 2026 Arnoldovna
