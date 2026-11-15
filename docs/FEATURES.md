# Imageboard: Features and Acceptance Criteria

This document defines **what the rebuilt Imageboard must do**. It comes from a full read of the legacy
project (`_legacy/src/Imageboard`: `server.js`, `db.js`, `s3.js`, `config.json`, `sql/*.sql`,
`public/index.html`, `public/script.js`, `public/style.css`, `package.json`, `README.md`).
Modern expectations are added where the legacy app falls short.

Every criterion is numbered (`F-xx`), can be tested, and counts towards the Definition of Done in `PLAN.md`
("all FEATURES fulfilled"). Known defects of the legacy code are listed in [`BUGS.md`](./BUGS.md).
Several criteria below exist specifically to close a `B-xx` item.

## 0. Conventions

| Tag | Meaning |
|---|---|
| **(legacy)** | The legacy app has this behaviour, and the rebuild keeps it. |
| **(changed)** | The legacy app has this feature, but the rebuild deliberately changes it (usually because of a bug). |
| **(new)** | The legacy app does not have this. It is a modern expectation added for the rebuild. |

- "MUST" criteria are binding. Ideas that are explicitly not binding are listed in §10 (Out of scope).
- Test level hints: **[U]** unit (Vitest), **[A]** API/integration (Supertest + Testcontainers),
  **[E]** end-to-end (Playwright, with axe for accessibility).
- Limits (lengths, sizes, page sizes, rate limits) are defaults. They live in one configuration module, and the
  backend (Zod) and frontend (same Zod schema from `packages/shared`) share them.
- All UI text is in English.

## 1. Legacy feature inventory

This is what the legacy app actually does, and where each item goes in the rebuild:

| # | Legacy behaviour | Legacy location | Rebuild |
|---|---|---|---|
| L-1 | Gallery of the 9 newest images, newest first | `db.js:46-52`, `index.html:40-50` | F-01, F-02 |
| L-2 | Image title appears only on mouse hover | `style.css:25-28, 49-51` | F-03 (changed) |
| L-3 | "MORE" button loads the next 9 older images | `db.js:33-45`, `script.js:183-205` | F-04, F-05 |
| L-4 | Clicking an image opens a full-screen modal (image, title, description, date, username) | `index.html:73-121`, `script.js:2-98` | F-11 |
| L-5 | Deep link through `#<id>` opens the modal on load; closing clears the hash | `script.js:113, 118-121, 143-146` | F-12 |
| L-6 | Comments listed in the modal (text, username, date) | `db.js:73-79`, `index.html:107-117` | F-26 |
| L-7 | Anyone can add a comment with a free-text username; it is prepended to the list | `server.js:74-84`, `script.js:58-80` | F-28 |
| L-8 | **Anyone** can delete **any** image; its comments are deleted first | `server.js:109-126`, `db.js:93-109` | F-35, F-36 (changed) |
| L-9 | Upload form (username, title, description, file) uploads to S3 and prepends the image to the gallery | `server.js:86-107`, `s3.js`, `script.js:147-166` | F-17 to F-25 |
| L-10 | Upload size limit 2 MiB (server); `accept="image/*"` (client only) | `server.js:25-27`, `index.html:32` | F-19, F-20 (changed) |
| L-11 | Upload bar sticks to the top when scrolling (JavaScript scroll handler) | `script.js:210-223`, `style.css:57-62` | F-57 (changed) |
| L-12 | Header heading "form/vue"; footer with GitHub and LinkedIn icon links | `index.html:21-24, 57-65` | F-58, F-59 |

The legacy app has **no authentication, no sessions, no real-time features, no validation, no error/empty/loading
states and no tests**.

## 2. Data model

### 2.1 Legacy (reference only)

```
images   (id SERIAL PK, url VARCHAR(300) NOT NULL, username VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT now)
comments (id SERIAL PK, username VARCHAR(255) NOT NULL, comment TEXT NOT NULL,
          user_id INT NOT NULL REFERENCES images(id),   -- misnamed: holds the IMAGE id
          created_at TIMESTAMP DEFAULT now)
```

### 2.2 Target (new). The final column names are set in the DB-schema ADR.

`images`

| Column | Type / constraint | Notes |
|---|---|---|
| `id` | `integer generated always as identity` PK | |
| `object_key` | `text NOT NULL UNIQUE` | Storage key only (for example `images/<uuid>.webp`), **never** an absolute URL (B-35) |
| `mime_type` | `text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif'))` | Detected from the file content, not taken from the client |
| `width`, `height` | `integer NOT NULL CHECK (> 0)` | Lets the gallery reserve space and avoid layout shift (F-09) |
| `size_bytes` | `integer NOT NULL CHECK (> 0)` | |
| `author_name` | `text NOT NULL CHECK (char_length(btrim(author_name)) BETWEEN 1 AND 60)` | Free-text display name (renames legacy `username`) |
| `title` | `text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120)` | |
| `description` | `text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000)` | |
| `owner_id` | `uuid NOT NULL` | Anonymous session identity of the uploader (F-34). It is never exposed in the API. |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |

Index: `(created_at DESC, id DESC)` for keyset pagination.

`comments`

| Column | Type / constraint | Notes |
|---|---|---|
| `id` | identity PK | |
| `image_id` | `integer NOT NULL REFERENCES images(id) ON DELETE CASCADE` | Renames legacy `user_id` (B-38) |
| `author_name` | `text NOT NULL CHECK (1..60 after trim)` | |
| `body` | `text NOT NULL CHECK (1..1000 after trim)` | Renames legacy `comment` |
| `owner_id` | `uuid NOT NULL` | Anonymous session identity of the commenter |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |

Index: `(image_id, created_at DESC, id DESC)` (B-40).

- **F-D1** (new) [A]: The schema is created only through versioned Drizzle migrations. There are no `DROP TABLE`
  scripts. `pnpm db:migrate` on an empty database followed by a second run succeeds both times without changes.
- **F-D2** (new) [A]: Deleting an image row deletes its comments through `ON DELETE CASCADE` in a single
  statement or transaction.
- **F-D3** (new) [A]: Every length and enum rule above is enforced **both** by Zod (API) and by a DB `CHECK`. A
  direct DB insert that violates a rule fails.

## 3. Routes and endpoints

### 3.1 Legacy (reference only)

| Method | Path | Behaviour |
|---|---|---|
| GET | `/image` | 9 newest images (array) |
| GET | `/image/more/:id` | 9 images with `id < :id` |
| GET | `/modal/:id` | `{ result: image, data: comments[] }`; `{}` on error |
| POST | `/comment/:id` | JSON `{username, comment}` → comment row |
| POST | `/upload` | multipart `file, username, title, desc` → `[imageRow]` |
| POST | `/delete/:id` | deletes comments + image, then `302 → /` |
| — | `#<id>` (client hash) | opens the modal |

### 3.2 Target API (new). Prefix `/api`, JSON, contract defined as Zod schemas in `packages/shared`.

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/images?cursor=&limit=` | `200 { items: ImageDto[], nextCursor: string \| null }` | 400 |
| GET | `/api/images/:id` | `200 ImageDto` | 400 (non-integer id), 404 |
| POST | `/api/images` (multipart: `file`, `authorName`, `title`, `description`) | `201 ImageDto` + `Location` | 400, 403 (CSRF), 413, 415, 429 |
| DELETE | `/api/images/:id` | `204` | 403 (not owner / CSRF), 404, 429 |
| GET | `/api/images/:id/comments?cursor=&limit=` | `200 { items: CommentDto[], nextCursor }` | 400, 404 |
| POST | `/api/images/:id/comments` (JSON `authorName`, `body`) | `201 CommentDto` | 400, 403, 404, 429 |
| DELETE | `/api/comments/:id` | `204` | 403, 404, 429 |
| GET | `/api/session` | `200 { csrfToken }` and the session cookie is set | — |
| GET | `/api/health` | `200 { status: "ok" }` when DB and storage are reachable, otherwise `503` | — (internal: not routed by nginx, see §14 R-08) |

`ImageDto = { id, url, previewUrl, width, height, mimeType, authorName, title, description, createdAt (ISO 8601),
canDelete }` (`previewUrl` added by §14 R-06).
`CommentDto = { id, imageId, authorName, body, createdAt, canDelete }`.
`url` is built from the configured public media base URL and `object_key`. `owner_id` never leaves the server.

Frontend routes (Vue Router, history mode): `/` (gallery), `/images/:id` (detail dialog over the gallery),
and a catch-all 404 page.

## 4. Gallery

- **F-01** (legacy) [A][E]: `/` shows images ordered newest first (`created_at DESC, id DESC`).
- **F-02** (changed) [A]: The first page holds `PAGE_SIZE` images (default **12**, divisible by 2, 3 and 4 columns;
  legacy used 9). `limit` is clamped to 1..50. Larger values are capped, not rejected.
- **F-03** (changed) [E]: Each tile always shows the image, its title and its author name. The title is no longer
  hover-only, so touch and screen-reader users get it too (B-68). Each tile is a single link to `/images/:id`
  whose accessible name is the image title (exactly the title: see F-55 and §14 R-05).
- **F-04** (changed) [A][E]: A "Load more" button appends the next page using **keyset pagination**
  (`nextCursor`). Uploading or deleting images between two page requests never causes duplicates or
  skipped items in the list.
- **F-05** (changed) [A][E]: The "Load more" button is shown **only** when `nextCursor` is not null. With
  ≤ `PAGE_SIZE` images it never appears. It disappears correctly even when the oldest image (id 1) has been deleted
  (B-46).
- **F-06** (new) [E]: While the first page loads, the grid shows a loading state (`aria-busy="true"` with
  skeleton tiles or a spinner with an accessible label). While "Load more" is in flight the button is disabled and
  reads "Loading…".
- **F-07** (new) [E]: With zero images the gallery shows the empty state "No images yet. Be the first to upload
  one." and moves focus or a link to the upload form. The page does not crash (B-46).
- **F-08** (new) [E]: If loading the gallery or the next page fails, an inline error message with a "Try again"
  button appears. Images that were already loaded stay visible.
- **F-09** (new) [E]: Every `<img>` has `width`/`height` attributes (from the stored dimensions), `loading="lazy"`
  (except the first row) and `decoding="async"`. The cumulative layout shift of the gallery is < 0.1.
- **F-10** (new) [E]: The grid is responsive: 1 column at 320 px, up to 4 columns on wide screens. There is no
  horizontal page scroll anywhere between 320 px and 1920 px viewport width.

## 5. Image detail

- **F-11** (legacy) [E]: Activating a tile opens the detail view as a modal dialog over the gallery. It shows the
  large image, title (as a heading), description, author name and upload date.
- **F-12** (changed) [E]: The detail view has its own URL `/images/:id` (legacy: `#id`). Opening the URL directly
  or reloading the page shows the dialog over the gallery. Browser Back closes it. Closing it returns to `/` with no
  stray `#` in the URL (B-59).
- **F-13** (changed) [A][E]: `GET /api/images/:id` for an unknown id returns `404` problem+json, and a non-integer
  id returns `400` (the DB never sees invalid input, B-13). The UI shows "Image not found" with a link back to the
  gallery instead of silently closing (B-21, B-49).
- **F-14** (new) [U][E]: Dates are rendered as `<time datetime="<ISO>">` in a readable `en` format (for example
  "15 Nov 2026, 14:03") in the viewer's time zone, never as a raw ISO string (B-60).
- **F-15** (new) [E]: The dialog is accessible: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing
  to the title heading. Focus moves into the dialog on open and is trapped inside it. `Esc` closes it. The close
  control is a `<button>` named "Close". On close, focus returns to the tile that opened it. The page behind
  does not scroll (B-69).
- **F-16** (new) [E]: While the detail data loads, a loading state is shown. Navigating from image A to image B
  never briefly shows A's data under B's URL, and the detail is fetched **once** per open (B-48).

## 6. Upload

- **F-17** (legacy) [E]: The gallery page offers an upload form with **Name**, **Title**, **Description**
  (optional) and **Image** fields. After a successful upload the new image appears as the first tile without a
  page reload.
- **F-18** (changed) [A][U]: Server-side validation (shared Zod schema), applied to trimmed values:
  `authorName` 1–60 chars, `title` 1–120, `description` 0–2000, `file` required, exactly one file. On violation
  the API returns `400` problem+json with an `errors` array (`{ field, message }`), and **nothing is stored**,
  neither in the DB nor in object storage (B-24, B-25).
- **F-19** (changed) [A]: Only JPEG, PNG, WebP and GIF are accepted. The type is determined from the
  **file contents (magic bytes)**, not from the client's MIME type or file extension. SVG, HTML, PDF, renamed
  files and everything else are rejected with `415` and the message "Only JPEG, PNG, WebP or GIF images are
  allowed." (B-04, B-05) *(Annotated, §14 R-07: animated PNG (APNG) counts as PNG and is stored as a static PNG.)*
- **F-20** (changed) [A][E]: Maximum file size is `UPLOAD_MAX_BYTES` (default 5 MiB; legacy 2 MiB, which most
  phone photos exceed). Larger files are rejected with `413` problem+json ("The image must be 5 MB or smaller.").
  The client checks size and type **before** sending and shows the same message.
- **F-21** (new) [A]: The client's original filename is never used for storage. The object key is
  server-generated (random UUID plus the extension of the **detected** type). Multipart limits restrict the request
  to 1 file and the known text fields; anything else gives `400`.
- **F-22** (new) [A]: The stored image is re-encoded. EXIF and other metadata (including GPS location) is
  stripped (B-06). The stored object's `Content-Type` equals the detected type, and objects are served with
  `X-Content-Type-Options: nosniff`. Width, height and size are stored. *(Annotated, §14 R-06: a derived WebP preview
  rendition is stored next to the original for gallery tiles; this criterion applies to the original.)*
- **F-23** (new) [A]: The upload is consistent. If the DB insert fails after the object was stored, the object is
  deleted again. If storage fails, no row is created. No temporary files remain on disk after a success or a
  failure (B-25, B-34).
- **F-24** (new) [E]: Form UX: a real `<form>` (Enter submits) with visible `<label>`s and required markers.
  Errors appear inline under each field and are linked through `aria-describedby`/`aria-invalid`. The file picker is
  reachable and operable by keyboard and shows the chosen filename plus a preview. While uploading, the submit
  button is disabled and reads "Uploading…" (no double submit). On success **all** fields including the file are
  reset, and "Image uploaded." is announced through a live region. On failure the entered values are kept (B-54).
- **F-25** (new) [A]: The uploaded image belongs to the uploader's anonymous session (F-34). In the `201`
  response, `canDelete` is `true`.

## 7. Comments

- **F-26** (legacy) [E]: The detail view lists the image's comments with body, author name and date.
- **F-27** (changed) [A]: Comments are ordered **newest first** (`created_at DESC, id DESC`), and the order is
  stable when the dialog is reopened (B-41).
- **F-28** (legacy) [E]: A visitor can add a comment with **Name** and **Comment**. It appears at the top of the
  list immediately, without a reload.
- **F-29** (changed) [A][E]: Validation on trimmed values: `authorName` 1–60, `body` 1–1000. Violations give
  `400` problem+json with field errors shown inline. Commenting on a non-existent image gives `404` (B-26).
- **F-30** (new) [E]: With no comments the list shows "No comments yet. Start the conversation." Loading and
  error states work as in F-06 and F-08.
- **F-31** (new) [A][E]: Comments are paginated (default 20 per page, keyset) with a "Show older comments" button
  shown only when more exist (B-45).
- **F-32** (new) [A][E]: The session that wrote a comment can delete it (`204`). Any other session gets `403`.
  The UI shows the delete control only when `canDelete` is `true`.
- **F-33** (new) [E]: The comment form is a `<form>` with labels. Submit is disabled while sending. The form resets
  on success and keeps its values on error (B-55).

## 8. Ownership, sessions and deletion ("auth flows")

The legacy app has no authentication at all. Anyone can post under any name and delete anything (B-02, B-12).
Accounts are **not** in scope for the Imageboard (module cut: images, comments, upload). Ownership uses
anonymous sessions instead:

- **F-34** (new, **revised** §14 R-01) [A]: On the first request to `/api/session` (made by the frontend at startup),
  the server creates an anonymous session with a random identity (`owner_id`, UUID v4). The session cookie is
  `HttpOnly`, `SameSite=Lax`, `Secure` in production and signed. A session that has never created content is
  provisional and expires after 24 hours of inactivity; after the first successful upload or comment its max-age
  becomes the configurable full lifetime (default 180 days). Creating new identities is rate-limited per IP. The
  session is stored server-side (Redis). The cookie contains no data beyond the session id.
- **F-35** (changed) [A][E]: `DELETE /api/images/:id` succeeds (`204`) **only** for the session that uploaded the
  image. Other sessions get `403` problem+json, and unknown ids get `404`. The "Delete image" button is rendered only
  when `canDelete` is `true` (B-02, B-56).
- **F-36** (changed) [A]: Deleting an image removes, in one transaction, the image row and all of its comments
  (cascade), then deletes the stored object. After the `204`, `GET /api/images/:id` returns `404` and the media URL
  no longer serves the file (B-07, B-22).
- **F-37** (new) [E]: Deleting asks for confirmation in an accessible dialog ("Delete this image? This cannot be
  undone.", buttons "Delete" / "Cancel", focus on "Cancel"). After success the detail dialog closes, the image is
  removed from the loaded gallery **without** resetting the list or scroll position, and "Image deleted." is
  announced. On failure an error message is shown and the image stays (B-47, B-56).
- **F-38** (new) [E]: The author name is labelled "Name (shown publicly)". The UI never suggests that a name is a
  verified identity (B-12).

## 9. Cross-cutting: security, API quality, operations

- **F-39** (new) [A]: Every state-changing request (POST/DELETE) needs a valid CSRF token (double-submit or
  synchronizer token tied to the session). Without one the server returns `403`. The token comes from
  `GET /api/session` (B-03).
- **F-40** (new, **revised** §14 R-02) [A]: Rate limits per IP (Redis store, configurable): uploads 10 per hour,
  comments 20 per 10 minutes, deletes 30 per 10 minutes, everything else 300 per 5 minutes. Exceeding a limit
  returns `429` problem+json with `Retry-After` (B-09). Deviations: media files (`/api/media/*`) have their own
  budget of 1200 per 5 minutes instead of counting against the 300; new anonymous identities are limited to 20 per
  hour per IP; all uploads together are capped at 200 per day; `/api/health` has no limiter because it is not
  reachable from outside.
- **F-41** (new) [A]: All errors are `application/problem+json` (RFC 9457) with `type`, `title`, `status`,
  `detail`, and `errors[]` for validation errors. Responses never contain stack traces, SQL or driver messages.
  Unknown `/api/*` routes give `404` problem+json. Every request receives a response; no request hangs (B-11,
  B-17).
- **F-42** (new) [A]: Security headers via helmet: a strict CSP (no inline scripts; `img-src 'self'` plus the
  configured media origin), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  HSTS in production, no `X-Powered-By` (B-10).
- **F-43** (new) [A]: Responses contain only the DTO fields listed in §3.2 (explicit column selection or mapping,
  no `SELECT *`). `owner_id` never appears in any response (B-28).
- **F-44** (new) [A]: Route params and query strings are validated (positive integer ids up to 2^31−1, opaque
  cursor strings). Invalid input yields `400`/`404` and never a DB error (B-13).
- **F-45** (new) [U]: All configuration (port, DB URL, Redis URL, S3 endpoint/bucket/credentials, public media
  base URL, upload limit, page sizes, rate limits, session secret) comes from environment variables that are
  validated by Zod at startup. Invalid or missing config stops the process with a clear message. `.env.example`
  documents every variable, the repo contains no secrets, and gitleaks passes (B-01, B-30).
- **F-46** (new) [A]: Structured logging via pino with a request id, level-based. Bodies, cookies, CSRF tokens and
  credentials are redacted. `console.log` is banned by ESLint (B-29).
- **F-47** (new) [A]: `GET /api/health` reports readiness (DB + storage). On `SIGTERM` the server stops accepting
  connections, finishes in-flight requests and closes the DB pool. *(Annotated, §14 R-08: the endpoint is for the
  container healthcheck and load balancer only; nginx does not route it publicly, and results are cached for 3 s.)*
- **F-48** (new) [A]: Object storage uses AWS SDK v3 (MinIO locally through Docker Compose). The bucket uses **no
  object ACLs**. Read access goes through a bucket policy/CDN or signed URLs, as decided in an ADR. The DB stores
  only the object key (B-08, B-35, B-36).
- **F-49** (new) [A]: The API rejects JSON bodies over 16 KB (`413`) and non-JSON content types on JSON endpoints
  (`415`).

## 10. Accessibility and UI

- **F-50** (new) [E]: axe reports **no serious or critical** violations on: the gallery (filled and empty), the
  open detail dialog, the upload form with validation errors, and the delete confirmation.
- **F-51** (new) [E]: Every feature can be used with the keyboard alone. Every interactive element shows a
  visible `:focus-visible` indicator with ≥ 3:1 contrast. Focus outlines are never removed (B-71).
- **F-52** (new) [E]: Text contrast is ≥ 4.5:1 (≥ 3:1 for large text and UI component boundaries), checked against
  the maw design tokens (B-72).
- **F-53** (new) [E]: `<html lang="en">`, `<meta charset>`, `<meta name="viewport">`. The document title changes
  per route ("Imageboard" / "<image title> · Imageboard") (B-64).
- **F-54** (new) [E]: Heading hierarchy: one `h1` (app name); "Upload an image" and "Gallery" as `h2`; the image
  title as the dialog's heading; "Comments" as a sub-heading. Headings are never used just for font size (B-70).
- **F-55** (new, **revised** §14 R-05) [E]: Every image has a text alternative. The dialog image uses the image title
  as `alt`. A gallery tile image uses `alt=""` because the title is already text inside the same link, and the link
  is named by that title through `aria-labelledby` (WCAG technique H2; a title in both `alt` and text would read it
  twice). Decorative icons use `alt=""`/`aria-hidden`. Icon-only controls have an accessible name (B-65, B-73).
- **F-56** (new) [E]: Status changes (uploaded, deleted, comment added, errors) are announced through an
  `aria-live="polite"` region. Errors that block a form move focus to the first invalid field. *(Annotated, §14 R-04:
  while a modal dialog is open, the announcement goes to a live region inside that dialog, because the page behind a
  modal dialog is inert.)*
- **F-57** (changed, **revised** §14 R-03) [E]: The upload bar may stay visible while scrolling, but only through CSS
  `position: sticky` (no scroll listener), and it causes no layout jump (B-58). The sticky part is a compact one-row
  bar with an "Upload an image" disclosure button (`aria-expanded`); the form itself opens below it in normal page
  flow, on every screen width.
- **F-58** (changed) [E]: The footer links to Marina's GitHub profile and LinkedIn with visible or accessible text
  ("GitHub", "LinkedIn") and `rel="noopener"` where `target="_blank"` is used. Icons are self-made or properly
  licensed and attributed (B-73). *(Annotated, §14 R-09: both profile URLs live in one constant marked "Marina to
  confirm"; tests check only that the links exist.)*
- **F-59** (legacy) [E]: The page header shows the app name as `h1`. The wording follows the maw design
  ("form/vue" may stay as a tagline).
- **F-60** (new) [E]: Animations and hover transforms respect `prefers-reduced-motion: reduce`.
- **F-61** (new) [E]: All styling follows `PLAN.md` (Tailwind 4 via `@apply` in separate CSS files, BEM, maw
  `@theme` tokens only, no utility classes in markup, no hard-coded colours, no ID selectors) (B-77 to B-84).

## 11. Real-time

- **F-62** (legacy, documented): The legacy app has **no** real-time events (no WebSocket, SSE or polling). The
  rebuild does not need any. New images and comments from other visitors appear after the next fetch (page load,
  "Load more", reopening the dialog). This is intentional and must not be counted as missing.

## 12. Developer experience and seed data

- **F-63** (new) [A]: `pnpm db:seed` creates idempotent demo content: ≥ 15 images (own or openly licensed photos,
  with the licence noted in the repo) uploaded to local MinIO, with comments. It never points at third-party
  buckets (B-44).
- **F-64** (new): `pnpm dev` starts the API and web app against Docker Compose (Postgres, Redis, MinIO) using only
  `.env` values documented in `.env.example`. The README explains setup in ≤ 5 commands (B-33, B-85).
  *(Annotated: the setup is `pnpm install`, `pnpm dev:setup`, `pnpm dev`; see OVERVIEW §16.)*

## 13. Out of scope (not part of the Definition of Done)

- User accounts, login and registration (deliberately replaced by anonymous ownership, §8).
- Moderation/admin tools, reporting content, likes, tags, search.
- Live updates (WebSocket/SSE), infinite scroll, next/previous navigation inside the dialog.
- Image editing, cropping, multiple files per upload, server-side thumbnails in several sizes. An ADR may add
  thumbnails if performance requires them (ADR 0018 adds exactly one preview rendition, §14 R-06).

## 14. Revisions from the architecture review

The architecture critique (Etappe 1, round 1) changed or annotated these criteria. Each change is justified in the
ADR named; the criteria above carry a "revised" or "annotated" marker pointing here.

| # | Criteria | Change | ADR |
|---|---|---|---|
| R-01 | F-34 | Sessions that never created content are provisional (24 h); full lifetime after the first upload or comment; identity creation rate-limited | 0002 |
| R-02 | F-40 | Extra limiters: media (1200 / 5 min), identities (20 / h), global uploads (200 / day); health not limited (not public) | 0013 |
| R-03 | F-57 | Only a one-row bar is sticky; the form opens in normal flow on every width (was: whole form sticky on ≥ md) | 0012 |
| R-04 | F-56 | Announcements go to a live region inside the open dialog | 0010, 0011 |
| R-05 | F-03, F-55 | Tile image `alt=""`, tile link named by the title via `aria-labelledby`; dialog image keeps `alt` = title | 0012 |
| R-06 | §3.2, F-22, §13 | One WebP preview rendition per image; `ImageDto.previewUrl` | 0018 |
| R-07 | F-19 | APNG accepted as PNG (stored as static PNG) | 0005 |
| R-08 | §3.2, F-47 | `/api/health` internal only, cached 3 s | 0013 |
| R-09 | F-58 | Profile URLs in one constant to be confirmed by Marina | OVERVIEW §8.3 |
