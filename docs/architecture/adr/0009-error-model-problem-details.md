# ADR 0009: Error model: RFC 9457 problem details with stable codes

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-13, F-18, F-41, F-44, F-49; B-11, B-13, B-17, B-18, B-21, B-23, B-24, B-27

## Context

The legacy server swallows errors (requests hang, B-17), crashes on bad input (B-18), returns 200 for errors
(B-21) and leaks Express' HTML stack page for multer errors (B-11). PLAN.md requires a central RFC 9457 error
middleware; `express-feature-module` provides `AppError` + `toProblem`.

## Decision

- Every non-2xx API response is `application/problem+json` with `type`
  (`tag:arnoldovna.github.io,2026:imageboard:problem:<code>`), `title`, `status`, `detail`, `instance`, plus
  extension members `code`, `requestId` and, for validation, `errors: [{ field, location, message }]`.
- The stable `code` list (OVERVIEW §12) is a Zod enum in `packages/shared/src/problem.ts`; the web client switches
  on `code`, never on `detail` text. The API validates what it **sends** against the enum (tests); the client
  **parses** `code` leniently (`ProblemCode.or(z.string())`), so a new code from a newer API degrades to the generic
  message instead of breaking the SPA (web and API images are released separately). Non-problem error bodies (an
  nginx HTML 413, 502/504 while the API is down) become `ApiError { code: 'unexpected-response', status }` in the
  client (ADR 0010).
- Mapping in `shared/http/problem.ts`: `AppError` subclasses → their fields; `MulterError` → 413
  (`LIMIT_FILE_SIZE`), 400 `validation-failed` with `errors: [{ field: err.field, location: 'body', message: <that
field's "too long" message> }]` (`LIMIT_FIELD_VALUE`), or 400 `malformed-request` (all other multer codes);
  body-parser `entity.too.large` → 413, `entity.parse.failed` → 400 `malformed-request`; csrf-csrf
  `EBADCSRFTOKEN` → 403 `csrf-invalid`; rate limiter → 429 `rate-limited`; Postgres `23503` on comment insert → 404
  (in the repository/service, not the handler); Postgres `23514` → 400 `validation-failed` on the field named by the
  constraint (defence in depth, logged at `warn`, ADR 0006); everything else → 500 `internal-error` with a generic
  detail.
- `validate()` collects issues from params, query and body into one 400; the template's issue property `path` is
  renamed to `field` (FEATURES F-18).
- Express 5 forwards rejected promises; handlers have no flow-control `try/catch`. `notFoundHandler` for unknown
  `/api/*`.
- 5xx logged with the error at `error`, 4xx at `info` without stack. Bodies never include stack, SQL or driver
  messages. Process-level `unhandledRejection`/`uncaughtException` → `fatal` log + graceful shutdown with exit code 1
  (never 0, so a supervisor sees the crash; ADR 0013).
- Health endpoints return plain JSON (`{ status }`), not problems, because load balancers only read the status.

## Alternatives

- **Ad-hoc `{ error: string }` bodies**: no standard, no machine-readable codes.
- **Problem `type` as resolvable https URLs to docs**: nice, but needs a docs site; tag URIs are valid per RFC 9457
  and can be swapped later without client changes because clients use `code`.

## Consequences

- Every route test asserts `content-type: application/problem+json` and the `code` for each error case.
- The web `ApiError` maps `errors[]` into `fieldErrors` by `field`, shown inline with `aria-describedby`.
