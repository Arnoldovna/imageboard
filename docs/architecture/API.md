# Imageboard: HTTP API

Status: proposed (revised after the architecture critique, round 1) · Date: 15 Nov 2026 · Contract source: `packages/shared/src/*.ts` (Zod 4)

Base path `/api`, JSON (UTF-8) unless stated. The SPA and API share one origin (nginx in Docker/production, the Vite
proxy in development), so cookies are `SameSite=Lax` and the API has **no CORS middleware** (ADR 0003).
There are **no socket events** and no SSR routes (ADR 0016). Frontend routes are listed at the end.

## 0. Conventions

| Topic | Rule |
|---|---|
| Identity | Anonymous session cookie (`__Host-imageboard.sid` in production, `imageboard.sid` locally), created by `GET /api/session` (ADR 0002) |
| "Auth" column | `none` = public; `session+csrf` = needs the session cookie, a valid `x-csrf-token` header and a same-origin fetch (ADR 0003); ownership is checked in the service |
| Mutations | `POST`/`DELETE` only. `GET`/`HEAD` never change data (except `GET /api/session` creating the anonymous identity once) |
| Ids | Path ids: `^[1-9]\d{0,9}$` and ≤ 2147483647 (`IdParam`), else `400 validation-failed` (F-44) |
| Pagination | `?limit=&cursor=`; response `{ items, nextCursor }`; keyset on `created_at DESC, id DESC`; `limit` empty → default, non-integer → 400, `< 1` → 1, `> 50` → 50 (F-02); invalid cursor → `400 invalid-cursor` (ADR 0007) |
| Dates | ISO 8601 UTC with milliseconds (`2026-10-06T15:31:00.000Z`) |
| Errors | `application/problem+json`, codes in [OVERVIEW §12](./OVERVIEW.md#12-error-model) |
| JSON bodies | `Content-Type: application/json` required (else `415 unsupported-content-type`), ≤ 16 KB (else `413 payload-too-large`), unknown keys rejected (`.strict()` → 400) (F-49) |
| Strict in, tolerant out | Request schemas are strict on the server. Response DTOs are `z.object` (unknown keys stripped) and the client parses `code` as `ProblemCode.or(z.string())`, so additive API changes never break a deployed SPA (ADR 0010) |
| Text fields | multi-line fields: `\r\n` and `\r` become `\n` before NFC, trim and code-point counting; forbidden characters per DATA-MODEL §1.1 |
| Request id | `x-request-id` echoed on every response, also `requestId` in problem bodies |
| Rate-limit headers | `RateLimit` and `RateLimit-Policy` (IETF draft-8) on limited routes; `Retry-After` on 429 |
| Caching | API JSON: `Cache-Control: no-store`; media: `public, max-age=86400, immutable` |

### Shared schemas (exact)

```ts
// packages/shared/src/images.ts
export const ImageMimeType = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Response DTOs: z.object (tolerant reader). The API's own tests assert the exact key set it sends.
export const ImageDto = z.object({
  id: z.number().int().positive(),
  url: z.string().min(1),                 // `${MEDIA_PUBLIC_BASE_URL}/${objectKey}` (original, dialog)
  previewUrl: z.string().min(1),          // `${MEDIA_PUBLIC_BASE_URL}/previews/<uuid>.webp` (tiles, ADR 0018)
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mimeType: ImageMimeType,
  authorName: z.string(),
  title: z.string(),
  description: z.string(),                // '' when none
  createdAt: z.iso.datetime({ precision: 3 }),
  canDelete: z.boolean(),
});
export const ImagePage = pageOf(ImageDto); // { items: ImageDto[], nextCursor: string | null }

export const CreateImageFields = z.strictObject({
  authorName: singleLineText({ min: 1, max: LIMITS.authorName.max, messages: messages.authorName }),
  title: singleLineText({ min: 1, max: LIMITS.title.max, messages: messages.title }),
  description: multiLineText({ min: 0, max: LIMITS.description.max, messages: messages.description }).default(''),
});

// packages/shared/src/comments.ts
export const CommentDto = z.object({
  id: z.number().int().positive(),
  imageId: z.number().int().positive(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime({ precision: 3 }),
  canDelete: z.boolean(),
});
export const CommentPage = pageOf(CommentDto);
export const CreateCommentBody = z.strictObject({
  authorName: singleLineText({ min: 1, max: LIMITS.authorName.max, messages: messages.authorName }),
  body: multiLineText({ min: 1, max: LIMITS.commentBody.max, messages: messages.commentBody }),
});

// packages/shared/src/session.ts
export const SessionDto = z.object({ csrfToken: z.string().min(1), uploadMaxBytes: z.number().int().positive() });

// packages/shared/src/problem.ts
export const FieldError = z.object({
  field: z.string(),                                   // 'title', 'file', 'cursor', 'id', ...
  location: z.enum(['params', 'query', 'body', 'file']),
  message: z.string(),
});
export const ProblemDetails = z.looseObject({
  type: z.string(), title: z.string(), status: z.number().int(), detail: z.string(),
  instance: z.string().optional(),
  code: ProblemCode.or(z.string()),                    // tolerant: unknown codes fall back to a generic message
  requestId: z.string().optional(),
  errors: z.array(FieldError).optional(),
});
```

Field messages (`packages/shared/src/messages.ts`, used by API and UI):

| Field | Empty | Too long | Other |
|---|---|---|---|
| `authorName` | "Enter a name." | "Name must be 60 characters or fewer." | "Name must be on one line." |
| `title` | "Enter a title." | "Title must be 120 characters or fewer." | "Title must be on one line." |
| `description` | — | "Description must be 2,000 characters or fewer." | "Description contains characters that are not allowed." |
| `body` | "Write a comment." | "Comment must be 1,000 characters or fewer." | as description |
| `file` | "Choose an image to upload." | "The image must be 5 MB or smaller." (from `uploadMaxBytes`) | "Only JPEG, PNG, WebP or GIF images are allowed." · "The image could not be read." · "The image is too large to process." · "Animated images can have at most 200 frames." |

Client-only error codes (never sent by the API): `network` (fetch rejected) and `unexpected-response` (non-2xx
without a problem body, e.g. nginx 413/502/504): "The service is not available right now. Try again in a moment."
(413: the file size message).

---

## 1. Session

### `GET /api/session`

| | |
|---|---|
| Auth | none (creates the anonymous identity on first call) |
| Rate limit | global; plus `identities` (20 per hour per IP) **only** when a new identity is created |
| Request | no params, no body |
| Success | `200 SessionDto`, `Cache-Control: no-store`, sets the session cookie (first call or rolling refresh) and the CSRF cookie |
| Errors | `429 rate-limited`, `500 internal-error` (Redis down) |

Behaviour: if `req.session.ownerId` is unset, run the identity limiter, then set it to `crypto.randomUUID()` with a
provisional cookie lifetime of `SESSION_PROVISIONAL_HOURS` (24 h). The first successful upload or comment promotes
the session to `SESSION_MAX_AGE_DAYS` (180 days) via `markSessionActive` (F-34 revised, ADR 0002). Then
`generateCsrfToken(req, res)` bound to `req.session.id`. Calling it again returns a token that is valid for the same
session (the SPA calls it once at start and again only after `403 csrf-invalid`).

```json
{ "csrfToken": "2f7c…", "uploadMaxBytes": 5242880 }
```

## 2. Images

### `GET /api/images`

| | |
|---|---|
| Auth | none (session cookie, if present, only affects `canDelete`) |
| Query | `limit` (default `IMAGES_PAGE_SIZE` = 12, clamped 1..50), `cursor` (opaque, ≤ 200 chars) |
| Success | `200 ImagePage`, items ordered `created_at DESC, id DESC`; `nextCursor` is `null` when no older image exists (fetch `limit + 1`) |
| Errors | `400 validation-failed` (`limit=abc`), `400 invalid-cursor`, `429 rate-limited` |

```json
{ "items": [ { "id": 16, "url": "/api/media/images/0b9d…e1.jpg", "previewUrl": "/api/media/previews/0b9d…e1.webp",
  "width": 1600, "height": 1067,
  "mimeType": "image/jpeg", "authorName": "Tomás R.", "title": "Rooftops from the fifth floor",
  "description": "New flat, no lift, but this view makes the stairs bearable.",
  "createdAt": "2026-11-12T19:23:00.000Z", "canDelete": false } ],
  "nextCursor": "eyJ0IjoiMjAyNi0xMC0xMlQxMTowMjowMC4wMDBaIiwiaWQiOjV9" }
```

Guarantee (F-04): inserting or deleting images between two page requests never duplicates or skips an item that
existed at both requests, because the next page is "strictly older than the last item seen", not an offset.

### `GET /api/images/:id`

| | |
|---|---|
| Auth | none |
| Params | `id: IdParam` |
| Success | `200 ImageDto` |
| Errors | `400 validation-failed` (`abc`, `0`, `-1`, `1.5`, `2147483648`), `404 not-found` ("Image was not found."), `429` |

### `POST /api/images`

| | |
|---|---|
| Auth | session+csrf |
| Rate limit | global + uploads (`RATE_LIMIT_UPLOADS` = 10 per hour per IP) + uploads-global-day (`RATE_LIMIT_UPLOADS_GLOBAL_DAY` = 200 per day, all clients) |
| Content-Type | `multipart/form-data` (else `415 unsupported-content-type`) |
| Parts | `file` (exactly one file part), `authorName`, `title`, `description` (optional) — nothing else |
| Limits | file ≤ `UPLOAD_MAX_BYTES` (5 MiB); 3 fields; 16 KiB per field (2000 code points × 4 bytes plus CRs fit); 4 parts total |
| Success | `201 ImageDto` with `canDelete: true`, header `Location: /api/images/<id>` |

Processing order (each step aborts before anything is stored, ADR 0005/0008):

1. fetch-metadata guard, CSRF, `requireOwnerSession`, upload limiters.
2. multer (memory, `shared/http/multipart.ts`) → `413 payload-too-large` (`LIMIT_FILE_SIZE`), `400 validation-failed`
   on that field (`LIMIT_FIELD_VALUE`, field over 16 KiB) or `400 malformed-request` (second file, unexpected file
   field, too many fields/parts, truncated body).
3. `CreateImageFields` + "file present" → `400 validation-failed` with every issue in `errors[]` at once.
4. Magic bytes (`file-type`) ∈ {jpeg, png (incl. APNG), webp, gif} → else `415 unsupported-image-type`
   ("Only JPEG, PNG, WebP or GIF images are allowed."). Client filename and client MIME type are ignored.
5. Header inspection: pixels per frame > `UPLOAD_MAX_PIXELS` → `400 invalid-image` ("The image is too large to
   process."); frames > `UPLOAD_MAX_FRAMES` (200) → `400 invalid-image` ("Animated images can have at most 200
   frames.").
6. sharp decode/re-encode + preview → `400 invalid-image` ("The image could not be read.") on decode failure.
7. `PutObject images/<uuid>.<ext>`, then `previews/<uuid>.webp` → on failure discard what was stored,
   `500 internal-error`, no row.
8. `INSERT` → on failure delete both objects again, then `500 internal-error`.
9. `markSessionActive` (session gets its full lifetime), `201`.

| Error | When |
|---|---|
| `400 validation-failed` | missing/empty/too long fields, line break in title/name, unknown text field, missing file |
| `400 malformed-request` | see step 2 |
| `400 invalid-image` | see steps 5 and 6 |
| `403 csrf-invalid` / `cross-origin-request` / `session-required` | security checks |
| `413 payload-too-large` | file too big ("The image must be 5 MB or smaller.") |
| `415 unsupported-content-type` | not multipart |
| `415 unsupported-image-type` | not an allowed image by content |
| `429 rate-limited` | upload budget (per IP or global daily cap) used up |

### `DELETE /api/images/:id`

| | |
|---|---|
| Auth | session+csrf, owner only |
| Rate limit | global + deletes (`RATE_LIMIT_DELETES` = 30 per 10 min, shared with comment deletes) |
| Params | `id: IdParam` |
| Success | `204` (no body). The image row and all its comments are gone (cascade, one statement); original and preview are deleted after the commit; `GET /api/images/:id` → 404; both media URLs → 404 |
| Errors | `400 validation-failed`, `403 csrf-invalid` / `cross-origin-request` / `session-required`, `403 not-owner` ("You can only delete images you uploaded."), `404 not-found`, `429` |

## 3. Comments

### `GET /api/images/:imageId/comments`

| | |
|---|---|
| Auth | none |
| Params | `imageId: IdParam` |
| Query | `limit` (default `COMMENTS_PAGE_SIZE` = 20, clamped 1..50), `cursor` |
| Success | `200 CommentPage`, newest first (`created_at DESC, id DESC`) (F-27, F-31) |
| Errors | `400 validation-failed`, `400 invalid-cursor`, `404 not-found` (unknown image; checked through the injected `imageExists` only when the first page is empty), `429` |

### `POST /api/images/:imageId/comments`

| | |
|---|---|
| Auth | session+csrf |
| Rate limit | global + comments (`RATE_LIMIT_COMMENTS` = 20 per 10 min) |
| Body | `CreateCommentBody` JSON `{ "authorName": "Kofi", "body": "Where does it go?" }` |
| Success | `201 CommentDto` with `canDelete: true`, no `Location` header (there is no `GET /api/comments/:id`; the body is the resource). The session is promoted via `markSessionActive` |
| Errors | `400 validation-failed`, `403` security codes, `404 not-found` (image does not exist or was deleted meanwhile: FK `23503` mapped), `413 payload-too-large` (> 16 KB), `415 unsupported-content-type`, `429` |

### `DELETE /api/comments/:id`

| | |
|---|---|
| Auth | session+csrf, owner only |
| Rate limit | global + deletes |
| Success | `204` |
| Errors | `400 validation-failed`, `403` security codes, `403 not-owner` ("You can only delete comments you wrote."), `404 not-found`, `429` |

## 4. Media

### `GET /api/media/images/:file` and `GET /api/media/previews/:file` (and `HEAD`)

| | |
|---|---|
| Auth | none; no session, no CSRF (mounted before the session middleware) |
| Rate limit | media (`RATE_LIMIT_MEDIA` = 1200 per 5 min per IP); not counted by the global limiter |
| Params | originals: `file` must match `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$`; previews: same UUID pattern with `\.webp$` only; else `404` without calling S3. Two literal routes, because Express 5 has no inline regex parameters |
| Success | `200` body streamed from `storage.get(key, { ifNoneMatch })` (`stream.pipeline`), headers: `Content-Type` (stored), `Content-Length`, `ETag`, `Last-Modified`, `Cache-Control: public, max-age=86400, immutable`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`. `If-None-Match` matching → `304` (port result `not-modified`). `HEAD`: same headers, body stream destroyed unread |
| Errors | `404 not-found` (bad key, `ObjectNotFoundError` from the port), `429`, other S3 failures become `500 internal-error` |

## 5. Health

### `GET /api/health`

Readiness (F-47, B-87). Checks DB (`select 1`), Redis (`isReady`), S3 (`HeadBucket`) in parallel with a 2 s timeout
each; the result is cached for 3 s and concurrent callers share one in-flight check. No dependency details in the
body. Not logged on success. **Internal only**: nginx answers `404` for `/api/health*` from outside; the compose
healthcheck and a load balancer probe the api container directly. Therefore no rate limiter (ADR 0013).

| Status | Body |
|---|---|
| `200` | `{ "status": "ok" }` |
| `503` | `{ "status": "unavailable" }` or, after SIGTERM, `{ "status": "shutting-down" }` |

### `GET /api/health/live`

Liveness: `200 { "status": "ok" }` while the process runs.

## 6. Unknown routes

Any other `/api/*` path or method → `404 not-found` problem+json (F-41). Non-`/api` paths never reach the API (nginx
serves the SPA).

## 7. Endpoint matrix

| Method | Path | Auth | Limiters | Success | Error statuses |
|---|---|---|---|---|---|
| GET | `/api/session` | none | global, identities (new identity only) | 200 | 429, 500 |
| GET | `/api/images` | none | global | 200 | 400, 429 |
| GET | `/api/images/:id` | none | global | 200 | 400, 404, 429 |
| POST | `/api/images` | session+csrf | global, uploads, uploads-global-day | 201 | 400, 403, 413, 415, 429 |
| DELETE | `/api/images/:id` | session+csrf (owner) | global, deletes | 204 | 400, 403, 404, 429 |
| GET | `/api/images/:imageId/comments` | none | global | 200 | 400, 404, 429 |
| POST | `/api/images/:imageId/comments` | session+csrf | global, comments | 201 | 400, 403, 404, 413, 415, 429 |
| DELETE | `/api/comments/:id` | session+csrf (owner) | global, deletes | 204 | 400, 403, 404, 429 |
| GET, HEAD | `/api/media/images/:file`, `/api/media/previews/:file` | none | media | 200, 304 | 404, 429 |
| GET | `/api/health` (internal) | none | — | 200 | 503 |
| GET | `/api/health/live` (internal) | none | — | 200 | — |

Every route may also return `500 internal-error`.

## 8. Frontend routes (Vue Router, history mode)

Served by nginx `try_files $uri $uri/ /index.html` (production) and Vite (development).

| Path | Renders | Document title | Data |
|---|---|---|---|
| `/` | Header, upload panel, gallery, footer | `Imageboard` | `GET /api/session`, `GET /api/images` |
| `/images/:id` (digits only) | Same page plus the detail `<dialog>` | `<image title> · Imageboard` once loaded; `Image not found · Imageboard` on 404 | `GET /api/images/:id`, `GET /api/images/:id/comments` |
| anything else (incl. `/images/abc`) | Not-found page with a link "back to the gallery" | `Page not found · Imageboard` | none |
