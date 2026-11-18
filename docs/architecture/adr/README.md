# Architecture decision records

Format: context, decision, alternatives, consequences. Status `proposed` until the architecture critique in
Etappe 1 is done; then `accepted`. Superseding a decision means a new ADR that links the old one.

| ADR                                                        | Decision                                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](./0001-monorepo-with-feature-modules.md)            | pnpm monorepo, feature modules, Zod contract package, no feature-to-feature imports in the API                                                                                          |
| [0002](./0002-anonymous-session-ownership.md)              | Anonymous session identity (`owner_id`) instead of accounts; provisional sessions, production Redis                                                                                     |
| [0003](./0003-csrf-and-fetch-metadata.md)                  | csrf-csrf bound to the session id plus a Fetch Metadata guard; no CORS                                                                                                                  |
| [0004](./0004-media-storage-and-delivery.md)               | Private bucket, keys in DB, delivery through `/api/media`                                                                                                                               |
| [0005](./0005-image-ingestion-pipeline.md)                 | Memory multipart, magic-byte allow-list, sharp re-encode without metadata                                                                                                               |
| [0006](./0006-data-model-and-constraints.md)               | Identity keys, `timestamptz(3)`, CHECK constraints mirroring Zod                                                                                                                        |
| [0007](./0007-keyset-pagination.md)                        | Keyset pagination with opaque validated cursors                                                                                                                                         |
| [0008](./0008-upload-and-delete-consistency.md)            | Compensation on create, post-commit object delete with retries                                                                                                                          |
| [0009](./0009-error-model-problem-details.md)              | RFC 9457 problem details with stable codes                                                                                                                                              |
| [0010](./0010-frontend-state-management.md)                | Pinia for shared state, composables for scoped state, validated responses                                                                                                               |
| [0011](./0011-detail-dialog-as-nested-route.md)            | Detail as nested route in a native `<dialog>`                                                                                                                                           |
| [0012](./0012-styling-and-design-tokens.md)                | maw tokens, Tailwind 4 `@apply` only, 4-column gallery token, compact sticky upload bar, tile naming, no theme toggle                                                                   |
| [0013](./0013-rate-limits-health-and-request-limits.md)    | Rate-limit budgets (incl. identities, global daily uploads), 16 KB JSON, internal `/api/health`                                                                                         |
| [0014](./0014-seed-content.md)                             | Original seed artwork generated in code, processed like uploads                                                                                                                         |
| [0015](./0015-testing-strategy.md)                         | Test layers, database per test file, isolated e2e compose project                                                                                                                       |
| [0016](./0016-no-real-time-updates.md)                     | No real-time updates                                                                                                                                                                    |
| [0017](./0017-contract-first-stubs-for-parallel-builds.md) | Contract-first scaffold with stubs for parallel builds; exact cross-module types                                                                                                        |
| [0018](./0018-preview-rendition-for-gallery-tiles.md)      | One WebP preview rendition per image for gallery tiles                                                                                                                                  |
| [0019](./0019-deployment-readiness-and-abuse-handling.md)  | Pre-deploy checklist, forwarded scheme, takedown script, global upload cap, IP truncation                                                                                               |
| [0020](./0020-ci-cost-rule.md)                             | CI cost rule: e2e on pull requests only; GHCR release only for a public repository; deploy also needs `DEPLOY_ENABLED`                                                                  |
| [0021](./0021-consistency-pass-alignment.md)               | Alignment with the cross-project consistency pass: Phase 0 via `.devenv.sh`, importable working tree, template-DB setup file, e2e port override, seed guard, docs formatted by Prettier |

Revision 1 (15 Nov 2026) applied the first architecture critique. Changed ADRs say so in their status line; findings
that were only partly adopted are explained in the "Alternatives" section of the ADR concerned.

Consistency-pass review (16 Nov 2026) added ADR 0020 and 0021 and amended 0001, 0014, 0015, 0017 and 0019 accordingly.
