# Imageboard: Legacy Bugs, Security Holes and Bad Practices

This is an adversarial review of the legacy code in `_legacy/src/Imageboard` (git history: 2 commits, Nov 2018).
I read every file except `node_modules/` and the vendored `public/js/vue.js` / `public/js/axios.min.js`
(only their versions were checked). Line numbers refer to the legacy files.

**Rule for the rebuild:** every item below must be resolved, which is part of the Definition of Done in `PLAN.md`.
"Fix" describes the required best practice. `→ F-xx` points to the acceptance criterion in
[`FEATURES.md`](./FEATURES.md) that proves the fix.

Severity: **Critical** (exploitable now / data or credential loss) · **High** (security or data-integrity
defect) · **Medium** (functional bug, robustness, privacy) · **Low** (quality, maintainability, polish).

## Summary

| Area                             | Items              |
| -------------------------------- | ------------------ |
| Secrets and supply chain         | B-01, B-14 to B-16 |
| Security and privacy             | B-02 to B-13       |
| Server robustness and API design | B-17 to B-36       |
| Database                         | B-37 to B-45       |
| Frontend logic and UX            | B-46 to B-63       |
| HTML and accessibility           | B-64 to B-76       |
| CSS architecture                 | B-77 to B-84       |
| Project hygiene                  | B-85 to B-87       |

**Verified non-issues** (checked so that nobody "fixes" what isn't broken, and so the rebuild keeps it this way)
are at the end of the file.

---

## Secrets and supply chain

### B-01 · Critical · Credentials committed to git

- **Location:** `secrets.json:1-6` (tracked: `git ls-files` lists it, and there is no root `.gitignore`), loaded in `db.js:9` and `s3.js:9`.
- **What:** `secrets.json` holds the Postgres user/password and an AWS access key id and secret key (values not reproduced here). The comment in `s3.js:9` ("secrets.json is in .gitignore") is false.
- **Why it matters:** Anyone with read access to the repo, or to any fork/clone, gets AWS credentials (bucket abuse, cost) and a reused DB password. The secret stays in the history forever. See `_legacy/SECRETS-REPORT.md`: rotation is Marina's open task in PLAN stage 0.
- **Fix:** New repo with new history. No secrets file at all: configuration only through environment variables validated by Zod, with `.env` gitignored and `.env.example` committed. gitleaks in a lefthook pre-commit hook and in CI. Local development uses MinIO and Postgres credentials from Docker Compose that are not real secrets. → F-45

### B-14 · High · Outdated runtime and dependencies with known advisories

- **Location:** `package.json:10-22`; vendored `public/js/vue.js` (v2.5.13) and `public/js/axios.min.js` (v0.17.1).
- **What:** `engines.node` is 8.11.1 (EOL 2019). Installed: express 4.16.4, multer 1.4.1 (multer < 2.0 has published DoS advisories), body-parser 1.18.3, knox 0.9.2 (abandoned). Vue 2 reached end of life on 31 Dec 2023. axios 0.17.1 predates fixes for several published advisories (SSRF via redirects, ReDoS, XSRF-token leakage).
- **Why it matters:** Known-vulnerable code would ship. Nothing gets updated.
- **Fix:** Current Node LTS pinned in `.nvmrc`. Current Express 5, multer 2 (or busboy directly), Vue 3, and `fetch` or a current HTTP client. Dependabot (grouped) and `pnpm audit` in CI. → PLAN "Wartung"

### B-15 · Medium · `node_modules/` and `.DS_Store` committed, no `.gitignore`

- **Location:** repo root (`git ls-files` lists 824 files under `node_modules/`, plus `.DS_Store`).
- **What / why:** This bloats the repo and makes dependency updates impossible to review. It commits platform-specific binaries and leaks local macOS metadata.
- **Fix:** A root `.gitignore` (node_modules, dist, .env*, .DS_Store, coverage, playwright artefacts), pnpm lockfile only.

### B-16 · Medium · Frontend libraries vendored by hand, including the Vue _development_ build

- **Location:** `public/js/vue.js` (development build, recognisable by its `productionTip` config), `index.html:127-128`.
- **What / why:** There is no package manager or bundler for the client. The dev build is large and runs dev-only warnings in production. Versions are invisible to dependency scanners.
- **Fix:** Vite build with Vue 3 SFCs, dependencies in `package.json`, a production build in CI.

---

## Security and privacy

### B-02 · Critical · Anyone can delete any image (no authentication or authorisation)

- **Location:** `server.js:109-126`; UI `index.html:92`, `script.js:84-96`.
- **What:** `POST /delete/:id` deletes the image and all its comments for any caller. There is no session, owner check or token. The button is shown to every visitor.
- **Why it matters:** One `for i in $(seq 1 10000); do curl -X POST …/delete/$i; done` wipes the whole board. A careless click by any visitor also destroys other people's content.
- **Fix:** Anonymous session ownership (`owner_id` on images and comments). The DELETE route checks that the session's identity equals `owner_id` (403 otherwise). The UI renders delete only when `canDelete` is true. The check lives in the service layer and is covered by API tests. → F-34, F-35, F-32

### B-03 · High · No CSRF protection

- **Location:** `server.js:74, 86, 109` (all state-changing routes).
- **What:** There is no token and no Origin check. `POST /delete/:id` needs no body, so a plain cross-site `<form method="post">` can trigger it.
- **Why it matters:** Today any page can make a visitor's browser delete or spam content. Once cookie-based ownership exists (B-02 fix), CSRF becomes a direct authorisation bypass.
- **Fix:** CSRF token tied to the session (synchronizer or signed double-submit) on every POST/DELETE, `SameSite=Lax` cookies, and an Origin/`Sec-Fetch-Site` check as defence in depth. → F-39

### B-04 · High · No server-side upload type validation

- **Location:** `server.js:23-28` (no `fileFilter`); the only restriction is client-side `accept="image/*"` at `index.html:32`.
- **What:** The server accepts any file (HTML, SVG with script, executables, archives) and stores it publicly.
- **Why it matters:** The project's bucket can host malware or phishing pages, and storage abuse is possible.
- **Fix:** Allowlist JPEG/PNG/WebP/GIF, detected by **magic bytes** (for example `file-type`/`sharp` metadata). Reject everything else with 415 before anything is stored. → F-19

### B-05 · High · Client-controlled Content-Type and file extension stored as-is

- **Location:** `server.js:18` (`path.extname(file.originalname)`), `s3.js:22` (`"Content-Type": req.file.mimetype`).
- **What:** Both the stored extension and the served `Content-Type` come from the attacker. An `.html` or `.svg` file uploaded with `text/html` / `image/svg+xml` is served as such.
- **Why it matters:** This allows stored XSS and phishing under the bucket origin. Path-style URLs (`s3.amazonaws.com/<bucket>/`) also share one origin across buckets.
- **Fix:** Server-generated key with the extension of the **detected** type. Set `Content-Type` from detection, re-encode the image, and serve with `X-Content-Type-Options: nosniff`. Never trust `originalname` or `mimetype`. → F-21, F-22

### B-06 · High · Privacy: original files with EXIF/GPS metadata are published

- **Location:** `s3.js:26-28` streams the untouched upload to a `public-read` object.
- **What / why:** Phone photos usually carry GPS coordinates, device model and timestamps. The legacy app publishes them to the world.
- **Fix:** Re-encode with `sharp` (rotate according to EXIF, then strip all metadata) before storing. → F-22

### B-07 · High · Deleting an image leaves the file publicly reachable

- **Location:** `server.js:109-126` only deletes DB rows. Nothing calls S3 delete. `s3.js` has no delete function.
- **What / why:** A "deleted" image stays online under its old URL indefinitely. That is a privacy problem (users expect deletion), and orphaned objects keep costing money.
- **Fix:** The delete service removes the object after the DB transaction commits, retrying or logging failures (or a cleanup job for orphans). An API test asserts that the media URL returns 404 afterwards. → F-36

### B-08 · Medium · Object ACL `public-read`

- **Location:** `s3.js:24`.
- **What / why:** Per-object ACLs are a legacy S3 feature. New buckets have ACLs disabled and Block Public Access on, so this upload fails there. Opening ACLs also makes every object public with no central control.
- **Fix:** No ACLs. Read access goes through a bucket policy on a dedicated prefix or a CDN with origin access control, or through short-lived signed URLs (ADR). Locally: MinIO with an equivalent policy. → F-48

### B-09 · Medium · No rate limiting or abuse protection

- **Location:** whole server (`server.js`); there are no limits besides `fileSize`.
- **What / why:** Unlimited 2 MB uploads let anyone fill the bucket (cost DoS). Comment and delete endpoints can be scripted for spam or vandalism.
- **Fix:** `express-rate-limit` with a Redis store, per-route budgets, and 429 problem+json with `Retry-After`. → F-40

### B-10 · Medium · No security headers

- **Location:** `server.js:1-32` (no helmet, `X-Powered-By: Express` left on).
- **What / why:** No CSP, no nosniff, no HSTS, no referrer policy. The framework is fingerprinted.
- **Fix:** helmet with a strict CSP (no inline scripts or styles, `img-src` limited to self plus the media origin), HSTS in production, `app.disable('x-powered-by')` (helmet does this). → F-42

### B-11 · Medium · Unhandled multer errors fall through to Express' default HTML error page

- **Location:** `server.js:86` (`uploader.single("file")` has no error handling); `server.js:26` size limit.
- **What / why:** A file over 2 MiB (`LIMIT_FILE_SIZE`) or a malformed multipart body reaches the default handler. That handler returns an HTML 500 **with stack trace** when `NODE_ENV !== "production"`, and the client shows nothing (`script.js:163-165`). It should be 413/400.
- **Fix:** Central error middleware that maps known errors (multer limits → 413, validation → 400, not found → 404) to RFC 9457 problem+json, never exposes stacks, and logs with a request id. → F-41, F-20

### B-12 · Medium · Identity spoofing through free-text usernames

- **Location:** `server.js:76, 94`; `index.html:28, 102`; shown as "by {{username}}" in `index.html:91, 112`.
- **What / why:** Anyone can post as any name, and the UI presents it like an authenticated identity.
- **Fix:** Call it a public display name ("Name (shown publicly)"). Ownership comes from the session, never from the name. → F-37, F-34

### B-13 · Low · Route parameters are not validated

- **Location:** `server.js:49-50` (`/image/more/:id`), `56-60` (`/modal/:id`), `74-76` (`/comment/:id`), `109-111` (`/delete/:id`); client sends the raw hash, `script.js:113`.
- **What / why:** Non-numeric or out-of-range ids reach Postgres and raise `22P02`/`22003` errors. That produces hangs or crashes (B-17, B-18) and turns client errors into server errors.
- **Fix:** Zod schemas for `params`, `query` and `body` in a validation middleware: positive int ≤ 2^31−1, opaque cursors → 400/404. → F-44

---

## Server robustness and API design

### B-17 · High · Errors are swallowed, so requests hang forever

- **Location:** `server.js:44-46` (GET /image), `81-83` (POST /comment), `103-105` (POST /upload): the `catch` only logs, and no response is sent.
- **What / why:** Any DB error (constraint violation, connection loss) leaves the client waiting until it times out. Users see an endless state with no feedback, and sockets pile up.
- **Fix:** Express 5 async handlers (rejected promises reach the error middleware), central RFC 9457 error handler, and a test that asserts every failing path returns a problem response. → F-41

### B-18 · High · A single bad request can crash the server (unhandled rejection)

- **Location:** `server.js:49-54`: `GET /image/more/:id` has **no** `catch`.
- **What / why:** `GET /image/more/abc` makes Postgres reject the query. The rejection is unhandled, and since Node 15 an unhandled rejection terminates the process. That is a remote, unauthenticated DoS (on Node 8 it only printed a warning and the request hung).
- **Fix:** As B-17, plus input validation (B-13) and a process-level handler that logs and exits cleanly under a supervisor.

### B-19 · High · S3 stream has no error handlers; temp files leak on failure

- **Location:** `s3.js:21-40`.
- **What / why:** Neither `s3Request` nor `readStream` has an `'error'` listener. A network/DNS failure or a missing temp file emits `'error'` on an EventEmitter with no listener, which **crashes the process**. `fs.unlink` (`s3.js:39`) runs only in the `'response'` handler, so on error the temp file stays in `uploads/` (disk fills). The unlink callback ignores errors (`() => {}`).
- **Fix:** AWS SDK v3 `PutObjectCommand`/`Upload` with `await` inside try/catch. Process the image in memory under the size limit (no temp files), or use `stream.pipeline` with cleanup in `finally`. → F-23

### B-20 · Medium · `uidSafe()` promise without `catch` inside multer's callback

- **Location:** `server.js:16-20`.
- **What / why:** If `uidSafe` rejects, multer's `callback` is never called and the upload request hangs. It also mixes callback and promise styles.
- **Fix:** `crypto.randomUUID()` (synchronous, no failure path) for object keys.

### B-21 · Medium · Detail endpoint returns 200 for errors and for unknown ids

- **Location:** `server.js:56-72`: unknown id → `200 { result: undefined, data: [] }`; DB error → `200 {}` (`server.js:70`).
- **What / why:** The HTTP status lies. The client has to guess from a falsy field (`script.js:28`), and monitoring cannot see failures.
- **Fix:** `GET /api/images/:id` → 404 problem+json for an unknown id. Errors go through the error middleware. Comments are a separate paginated endpoint. → F-13

### B-22 · High · Delete flow: not awaited, not transactional, racy

- **Location:** `server.js:111-121`, `db.js:93-109`.
- **What:**
  1. `db.deleteImage(...)` at `server.js:114` is not `return`ed, so the redirect (`server.js:121`) is sent **before** the image is deleted, and a failure there becomes an unhandled rejection (see B-18).
  2. The `catch` at `server.js:116-118` swallows a failed comment deletion, and the chain still "succeeds".
  3. Comments and image are deleted in two separate statements without a transaction. A comment inserted between them makes the image delete fail on the FK, which leaves an image whose comments were destroyed.
  4. The client immediately re-fetches the gallery (`script.js:90, 167-181`). Because of (1), the "deleted" image can still appear.
- **Fix:** One `DELETE FROM images WHERE id = $1 AND owner_id = $2` with `ON DELETE CASCADE` (B-39) inside a transaction, awaited, then the storage delete (B-07), then `204`. The client removes the item from its store optimistically or after the 204. → F-36, F-D2

### B-23 · Medium · Wrong HTTP semantics for delete (POST + 302 redirect to an XHR)

- **Location:** `server.js:109, 121`.
- **What / why:** `res.redirect("/")` in response to an axios call makes the client follow the redirect and download `index.html` for nothing. Status codes and verbs are meaningless (POST to `/delete/:id`).
- **Fix:** `DELETE /api/images/:id` → `204 No Content`. → §3.2 of FEATURES

### B-24 · Medium · Dead `req.file` guard; missing file returns 500

- **Location:** `server.js:87` reads `req.file.filename` **before** the `if (req.file)` check at `server.js:90`. If that guard were ever false, no response would be sent. `s3.js:18-20` answers a missing file with `500`.
- **Fix:** Validate the request (file present, fields valid) first and answer `400` problem+json with field errors. → F-18

### B-25 · High · Validation happens only in the DB, after the file is already public

- **Location:** `server.js:86-106` (the order is: multer → S3 upload → DB insert); constraints in `sql/images.sql:5-7`.
- **What / why:** A request without `title` uploads the file to S3 first. The INSERT then fails on `NOT NULL`, the request hangs (B-17), and an orphaned public object remains. Empty strings (`""`) pass `NOT NULL`, so blank titles and usernames are accepted.
- **Fix:** Zod validation of all fields **before** any storage. On a DB failure after storage, delete the object (compensating action). DB `CHECK` constraints mirror Zod (B-43). → F-18, F-23

### B-26 · Medium · Comment endpoint without validation

- **Location:** `server.js:74-84`, `db.js:81-92`.
- **What / why:** Empty comments and names are stored, there is no length limit (`TEXT`), and missing fields give a NOT NULL error, which makes the request hang. A comment on a non-existent image gives an FK error and a hang instead of a 404.
- **Fix:** Zod body schema (trimmed, 1–60 / 1–1000) and an image-existence check → 404. → F-29

### B-27 · Low · Inconsistent, ad-hoc response shapes

- **Location:** upload returns an **array** (`db.js:63`, `server.js:101`, which forces `response.data[0]` in `script.js:158`); comment returns an **object** (`db.js:90`); the detail returns `{ result, data }` (`server.js:65`); `deleteComments` returns only the first deleted row (`db.js:107`).
- **Fix:** Typed DTOs defined once as Zod schemas in `packages/shared` and used by the API (validation and serialisation) and the client (types). → §3.2

### B-28 · Medium · `SELECT *` everywhere

- **Location:** `db.js:36, 48, 68, 75`.
- **What / why:** Every column is sent to the client. As soon as a sensitive column exists (for example `owner_id`), it leaks. It also overfetches.
- **Fix:** Explicit column selection in the repository (Drizzle `select({...})`) and mapping to DTOs. → F-43

### B-29 · Low · Debug `console.log` of full payloads in production code

- **Location:** `server.js:31, 51, 57-58, 62, 64, 78, 88, 91, 100, 110, 113, 120`; `db.js:1, 61, 88`; `s3.js:31, 33, 36`; `script.js:21, 26-27, 40, 45, 89, 116, 119, 125, 135, 137, 140, 170, 176, 191`.
- **What / why:** User data (comments, names, file info) goes to stdout and the browser console. Logs have no levels or structure, and messages like "RESULTTTT" are noise.
- **Fix:** pino with request ids and redaction. ESLint `no-console` (error) in both apps. → F-46

### B-30 · Medium · Hard-coded configuration

- **Location:** port `8080` (`server.js:128`, which ignores `PORT`, so the app cannot run on a PaaS despite the `NODE_ENV=production` branches); bucket `"spicedling"` (`s3.js:14`); public base URL (`config.json:2`); DB host/port/name (`db.js:14`); upload dir and 2 MiB limit (`server.js:14, 26`); page size `9` twice (`db.js:39, 48`).
- **Fix:** One Zod-validated config module fed from env, with constants (page sizes, limits) defined once and shared. → F-45

### B-31 · Low · Malformed DB connection string that works only by accident

- **Location:** `db.js:12-14`: `postgres:${user}:${pw}@localhost:5432/images` (missing `//`).
- **What / why:** It only parses because `spiced-pg` uses Node's lenient legacy `url.parse`. The WHATWG `URL` and `pg-connection-string` treat it differently. The `DATABASE_URL` / `secrets.json` split is also confusing.
- **Fix:** A single `DATABASE_URL` env var validated with `z.string().url()`.

### B-32 · Low · Static directory resolved relative to the working directory

- **Location:** `server.js:32` (`express.static("./public")`) versus `server.js:14` (`__dirname + "/uploads"`).
- **What / why:** Starting the server from another directory serves nothing. Path handling is inconsistent.
- **Fix:** The API does not serve the SPA in development (Vite dev server). In production, paths are resolved with `path.resolve(import.meta.dirname, …)` or the frontend is served by a separate container or the CDN.

### B-33 · Medium · `npm start` is broken; no scripts

- **Location:** `package.json:5, 8` point to `index.js`, which does not exist (the entry point is `server.js`). `package.json:7` has a failing placeholder test script.
- **Fix:** Working `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e` and `verify` scripts. → F-64, PLAN quality gate

### B-34 · Low · Unnecessary disk staging of uploads

- **Location:** `server.js:12-21` (multer `diskStorage` into `uploads/`), `s3.js:26, 39`.
- **What / why:** It is an extra I/O round trip, leaks temp files (B-19), and does not work on read-only or ephemeral container file systems.
- **Fix:** Memory storage with a strict size limit, then `sharp` re-encode, then `PutObject`. → F-23

### B-35 · Medium · Absolute, path-style S3 URLs stored in the database

- **Location:** `config.json:2` (`https://s3.amazonaws.com/<bucket>/`), `server.js:87`, `sql/images.sql:5` (`url VARCHAR(300)`).
- **What / why:** Storing hosts in data ties every row to one bucket, region and URL style. AWS no longer supports path-style URLs for new buckets. Switching to MinIO or a CDN would require a data migration.
- **Fix:** Store only `object_key`. Build the URL at serialisation time from `MEDIA_PUBLIC_BASE_URL`. → F-48, data model §2.2

### B-36 · High · `knox` S3 client is abandoned and uses Signature V2

- **Location:** `s3.js:1, 11-15` (knox signs with HMAC-SHA1, SigV2).
- **What / why:** SigV2 is deprecated and rejected in all regions launched after 2014 and for new buckets, so uploads fail on modern AWS. The library gets no security fixes.
- **Fix:** `@aws-sdk/client-s3` v3 (SigV4) with a configurable endpoint (MinIO locally, `forcePathStyle` only for MinIO). → F-48

---

## Database

### B-37 · Medium · No migrations: destructive `DROP TABLE` scripts with an ordering trap

- **Location:** `sql/images.sql:1`, `sql/comments.sql:1`.
- **What / why:** Running the scripts wipes all data. Re-running `images.sql` while `comments` exists **fails** ("cannot drop table images because other objects depend on it"). There is no record of which schema version a database has.
- **Fix:** Drizzle schema plus versioned migrations (`pnpm db:migrate`), and separate idempotent seeds. → F-D1, F-63

### B-38 · Medium · Misnamed foreign key `comments.user_id` (it references images)

- **Location:** `sql/comments.sql:7`; propagated to `db.js:73-75` (`showComments(user_id)`), `db.js:84`, `db.js:103`.
- **What / why:** The name suggests a users table that does not exist, which invites wrong joins and confuses every reader.
- **Fix:** Name it `image_id`. Use consistent, intention-revealing names (`body` instead of `comment`, `author_name` instead of `username`). → §2.2

### B-39 · Medium · No `ON DELETE CASCADE`, and a misleading `DELETE … CASCADE`

- **Location:** `sql/comments.sql:7` (plain `REFERENCES images(id)`); `db.js:95` and `db.js:103` (`DELETE FROM images CASCADE WHERE …`).
- **What / why:** `DELETE` has no `CASCADE` option. PostgreSQL parses the word as a **table alias**, so it does nothing. That forces the manual two-step delete with its race (B-22).
- **Fix:** `REFERENCES images(id) ON DELETE CASCADE` and a single DELETE. → F-D2

### B-40 · Medium · Missing index on the comments foreign key

- **Location:** `sql/comments.sql:7`.
- **What / why:** PostgreSQL does not index FK columns automatically. Every detail view (`db.js:75`) and every delete (`db.js:103`) scans the whole comments table.
- **Fix:** Index `(image_id, created_at DESC, id DESC)`, which supports both lookup and keyset pagination. → §2.2

### B-41 · Medium · Comments returned in undefined order

- **Location:** `db.js:75` (no `ORDER BY`); the client prepends new comments, `script.js:70`.
- **What / why:** A freshly posted comment shows at the top, but after reopening the dialog it appears wherever the planner returns it (usually at the bottom). The order is nondeterministic.
- **Fix:** `ORDER BY created_at DESC, id DESC` with keyset pagination. → F-27, F-30

### B-42 · Low · `TIMESTAMP` without time zone, nullable

- **Location:** `sql/images.sql:9`, `sql/comments.sql:8`.
- **What / why:** Times are ambiguous as soon as server and DB time zones differ, and `created_at` can be NULL.
- **Fix:** `timestamptz NOT NULL DEFAULT now()`. Serialise as ISO 8601 (UTC). → F-14

### B-43 · Medium · Weak constraints

- **Location:** `sql/images.sql:5-8`, `sql/comments.sql:5-6`.
- **What / why:** `NOT NULL` lets `''` and whitespace-only values through. `VARCHAR(255)` and unbounded `TEXT` are arbitrary and unbounded. `url VARCHAR(300)` can truncate or reject longer keys or URLs. The rules exist in neither API nor DB.
- **Fix:** `CHECK (char_length(btrim(x)) BETWEEN …)` that mirrors the shared Zod schema. `text` instead of arbitrary `varchar(n)`. → F-D3

### B-44 · Low · Seed data points at a third-party bucket

- **Location:** `sql/images.sql:12-31` (the bootcamp's shared bucket).
- **What / why:** The project does not own these images. They will 404 or change without notice, and the seed only works online.
- **Fix:** Self-owned or openly licensed sample photos in the repo (licence documented), uploaded to MinIO by `pnpm db:seed`. → F-63

### B-45 · Low · Comments are never paginated

- **Location:** `db.js:73-79`.
- **What / why:** A popular image would load every comment in one response.
- **Fix:** Keyset-paginated comments endpoint. → F-31

---

## Frontend logic and UX

### B-46 · Medium · "MORE" logic assumes the oldest image has id 1

- **Location:** `script.js:112` (`hasMore: true` initially), `script.js:186-200` (`images[images.length - 1].id == 1`).
- **What:**
  1. With ≤ 9 images, the MORE button is shown although nothing more exists.
  2. Once image id 1 is deleted, the condition is never true. The button stays forever and every click loads an empty page.
  3. With **zero** images, clicking MORE throws `TypeError` (`images[-1]` is `undefined`, `.id`).
- **Fix:** The server returns `nextCursor` (fetch `limit + 1` rows), and the client shows the button only when it is non-null. → F-04, F-05, F-07

### B-47 · Medium · `reload()` leaks a new `hashchange` listener per call and resets the list

- **Location:** `script.js:167-172` (a duplicate of `script.js:118-121`, registered again on every delete); `script.js:173-178` replaces the list with page 1.
- **What / why:** After _n_ deletions, _n+1_ identical listeners fire on every navigation. Each delete also throws away all "MORE" pages and the scroll position, and `hasMore` is not reset.
- **Fix:** Router-driven state (Vue Router + Pinia store). On delete, remove the item from the store, with no full reload. → F-36, F-12

### B-48 · Low · Opening an image fetches its data twice

- **Location:** `index.html:43-44` (click handler on the `div` **and** `href="#id"` on the inner link); `script.js:134-138` sets `imageId` to a number, then `script.js:120` sets it to the string from the hash. The watcher at `script.js:38-55` fires again because `5 !== "5"`.
- **Fix:** A single navigation source (router link to `/images/:id`), with the detail fetch keyed by the route param and duplicate in-flight requests cancelled with `AbortController`. → F-16

### B-49 · Medium · Not-found handling crashes the render

- **Location:** `script.js:28-32` and `script.js:46-50`: after `$emit("close2")` the code still assigns `self.image = undefined`, and the template reads `image.url` / `image.title` (`index.html:79, 88`), which throws a render `TypeError`.
- **Fix:** Explicit `loading | error | notFound | ready` states. → F-13, F-16

### B-50 · Low · Copy-pasted logic and inconsistent `this` aliases

- **Location:** fetch logic duplicated in `script.js:20-37` and `38-56`; gallery fetch duplicated in `script.js:115-131` and `167-182`; aliases `self`, `itself`, `its`, `me`, `instance` (`script.js:22, 63, 85, 154, 184`); `function` and arrow callbacks mixed.
- **Fix:** Composables and a Pinia store with one API client module. `<script setup lang="ts">`, with ESLint and Prettier enforcing a consistent style.

### B-51 · Low · Wrong `this` inside a callback

- **Location:** `script.js:88-89`: `this.imageId` inside a `function` callback is `undefined`.
- **Fix:** Arrow functions or `<script setup>` (no `this`). TypeScript strict catches it.

### B-52 · Low · Bogus click handler and missing `:key` on comments

- **Location:** `index.html:110`: `@click="upload-comment"` is evaluated as the expression `upload - comment` (`NaN`, plus a Vue warning about the undefined `upload`) on every click on a comment. The `v-for` has no `:key`.
- **Fix:** Remove it. `vue/valid-v-on` and `vue/require-v-for-key` lint rules.

### B-53 · Low · Dead event listener

- **Location:** `index.html:43`: `@delete="reload"` on a native `div`, which never emits `delete`.
- **Fix:** Remove it. Typed `defineEmits` makes such mistakes visible.

### B-54 · Medium · Upload UX defects

- **Location:** `script.js:147-166`, `index.html:27-34`.
- **What:**
  1. After success, only the text fields are cleared (`script.js:159-161`). `this.file` stays set, so the next submit **re-uploads the same file**.
  2. No double-submit guard (several clicks give several uploads).
  3. No client-side type or size check, so the 2 MiB limit only shows up as an unexplained failure.
  4. No progress, success or error feedback (the error is only logged, `script.js:163-165`).
  5. The chosen file name is never shown.
- **Fix:** → F-20, F-24

### B-55 · Low · Comment UX defects

- **Location:** `script.js:58-80`, `index.html:98-105`.
- **What / why:** No validation, no error display, no double-submit guard. The field order (comment before name) is unusual.
- **Fix:** → F-29, F-33

### B-56 · Medium · Destructive action without confirmation, visible to everyone

- **Location:** `index.html:92`, `script.js:84-96`.
- **What / why:** One click irreversibly deletes the image and all its comments, and failure is silent.
- **Fix:** Owner-only control plus a confirmation dialog and success/error feedback. → F-35, F-36

### B-57 · Medium · No loading, empty or error states anywhere

- **Location:** errors only logged at `script.js:34-36, 52-54, 74-79, 93-95, 128-130, 163-165, 179-181, 202-204`; `index.html:40` (`v-if="images.length"` with no `v-else`).
- **What / why:** Users see a blank page on errors and an empty page when there is no data, with no indication either way.
- **Fix:** → F-06, F-07, F-08, F-16, F-30

### B-58 · Medium · Sticky upload bar implemented with a scroll handler

- **Location:** `script.js:210-223`, `style.css:57-62`.
- **What / why:** It overwrites the global `window.onscroll` (and with it any other handler), runs unthrottled on every scroll event, and reads `offsetTop` only once at load. Switching to `position: fixed` removes the bar from the flow, so the content jumps by the bar's height. `.fixed-search` has no `z-index`, and a global variable named `input` is created.
- **Fix:** CSS `position: sticky` and no JavaScript. → F-57

### B-59 · Low · Hash-based pseudo-routing

- **Location:** `script.js:91, 113, 118-121, 145`.
- **What / why:** `location.hash = ""` leaves a trailing `#`. The unvalidated hash string goes straight into an API call. There are no real routes and no 404 page, and the detail URL is not meaningful to share.
- **Fix:** Vue Router (history mode) with `/images/:id` and a catch-all 404. → F-12

### B-60 · Low · Raw ISO timestamps shown to users

- **Location:** `index.html:91, 112` (`{{image.created_at}}`, `{{comment.created_at}}`).
- **Fix:** `Intl.DateTimeFormat` in a `<time datetime>` element. → F-14

### B-61 · Low · Global-script Vue 2 with an in-HTML x-template

- **Location:** `index.html:73-124, 127-129`; `script.js:1-2, 100-101`.
- **What / why:** It needs the runtime template compiler, and there are no modules, no build, no TypeScript, no tests and no tree-shaking.
- **Fix:** Vue 3 + Vite + TypeScript SFCs, feature folders, Vitest and Playwright.

### B-62 · Low · Commented-out dead code and non-English comments

- **Location:** `server.js:34-36`, `db.js:18-31`, `s3.js:42`, `script.js:19` (German comment), `script.js:59-61, 144`, `style.css:33, 182, 206-208, 211`.
- **Fix:** Delete it (git keeps history). All code and comments in English (PLAN rule).

### B-63 · Low · Meaningless names

- **Location:** events `close1` / `close2` / `close3` (`index.html:18`, `script.js:29, 47, 81-83, 143`); `myFunction` (`script.js:217`); `getBigImage`, `showComments`, `uploadData` (`db.js`); `data` / `result` response keys (`server.js:65`).
- **Fix:** Intention-revealing names (`close`, `deleted`, `findImageById`, `listCommentsForImage`, `createImage`), enforced in code review.

---

## HTML and accessibility

### B-64 · Medium · Broken document basics

- **Location:** `index.html:2` (no `lang`), `index.html:4-7` (no `<meta charset>`, no viewport meta), `index.html:5` (empty `<title>`).
- **What / why:** Screen readers guess the language, mobile browsers render a zoomed-out desktop page, and tabs and bookmarks have no name.
- **Fix:** → F-53

### B-65 · Medium · Images without alt text; invalid `</img>`

- **Location:** `index.html:45, 79` (`<img :src="image.url"></img>`).
- **What / why:** Images are announced as file names or URLs. `</img>` is invalid for a void element.
- **Fix:** `alt` = image title. Valid, linted templates (`vue/html-self-closing`). → F-55

### B-66 · Medium · Form controls without labels, not inside a `<form>`

- **Location:** `index.html:27-34` and `index.html:98-105` (placeholder only), plus `<br>` for layout at `index.html:101-102`.
- **What / why:** Placeholders are not labels (WCAG 1.3.1, 3.3.2) and disappear while typing. Enter does not submit, there is no native validation and no `autocomplete`.
- **Fix:** `<form @submit.prevent>`, `<label for>`, `required`, `maxlength`, `aria-describedby` errors. → F-24, F-33

### B-67 · High (a11y) · File picker is unreachable by keyboard

- **Location:** `style.css:120-122` (`input[type="file"] { display: none; }`), `index.html:31-32` (a `<label>` styled as a button).
- **What / why:** `display: none` removes the input from the tab order and the accessibility tree, so keyboard and screen-reader users cannot upload at all.
- **Fix:** A visually hidden but focusable input (or a native input styled with `::file-selector-button`), with a visible focus state on its label. → F-24, F-51

### B-68 · Medium · Gallery tiles: no accessible name, hover-only titles, duplicate IDs

- **Location:** `index.html:43-47`; `style.css:25-28, 49-51`.
- **What / why:** The link contains an `img` without `alt` and a `<p>` hidden with `visibility: hidden`, which also hides it from assistive technology, so the link has no accessible name. Touch users never see titles. `id="title"` repeats on every tile (invalid HTML). The click handler is on the wrapping `div` instead of the link.
- **Fix:** One `<a>` per tile with visible title and author, and class-based styling. → F-03

### B-69 · High (a11y) · Modal is not an accessible dialog

- **Location:** `index.html:73-121`, close control `index.html:75` (a `div` with an `img`).
- **What / why:** There is no `role="dialog"` or `aria-modal`, no label, the close control is not focusable and has no keyboard support, there is no `Esc`, no focus move or trap, and focus does not return. Background content stays reachable by tab and scrollable.
- **Fix:** A native `<dialog>` (`showModal()`) or an equivalent accessible component. → F-15

### B-70 · Low · Misused headings

- **Location:** image title as `<p>` (`index.html:88`) styled big through `nth-child`; comment bodies inside `<h6>` (`index.html:111`); jump from `h1` to `h6`.
- **Fix:** A semantic outline: `h1` app, `h2` sections and dialog title, comments as a list (`<ul>`/`<article>`). → F-54

### B-71 · High (a11y) · Focus indicators removed, hover-only feedback

- **Location:** `style.css:69, 221` (`outline: 0`); no `:focus` or `:focus-visible` rule anywhere; all feedback is `:hover` (`style.css:46, 76, 90, 107, 116, 140, 226, 243, 260, 306`).
- **What / why:** Keyboard users cannot see where they are (WCAG 2.4.7 / 2.4.11).
- **Fix:** Token-based `:focus-visible` ring on all interactive elements, and states that mirror hover. → F-51

### B-72 · Medium · Insufficient text contrast

- **Location:** `rgb(157,157,157)` text on white, about 2.7:1 (`style.css:20, 65, 215`); `rgb(159,159,159)` on `rgb(250,250,250)`, about 2.5:1 (`style.css:199` on `183`). All at 12 px.
- **What / why:** Fails WCAG 1.4.3 (4.5:1).
- **Fix:** maw tokens with verified contrast pairs. → F-52

### B-73 · Low · Footer: vague icon links, foreign repo link, missing attribution

- **Location:** `index.html:57-65`; icons `public/noun_*.png`.
- **What / why:** The alt texts "github code" and "linkedin" are vague. The GitHub link points to a bootcamp organisation repo, not Marina's own. `<br>` is used for layout. The Noun Project icons carry no attribution, which their free licence (CC BY) requires.
- **Fix:** Text or labelled links to Marina's own profiles, and self-made or properly attributed SVG icons with `aria-hidden`. → F-58

### B-74 · Low · Uppercase typed into the markup; ambiguous button labels

- **Location:** `index.html:31, 33, 52, 92, 99, 103` ("IMAGE UPLOAD", "SUBMIT", "MORE", "DELETE IMAGE", "ADD A COMMENT:").
- **What / why:** Some screen readers spell out all-caps text. Two different "SUBMIT" buttons are indistinguishable in a list of controls.
- **Fix:** Sentence-case text ("Upload image", "Post comment", "Load more") with optional `text-transform` in CSS.

### B-75 · Medium · Not responsive

- **Location:** no media queries in `style.css`; fixed sizes `style.css:31` (315 px tiles), `53, 131, 301` (150 px left padding), `152-153` (100 px), `170` (583 px), `177` (400 px); `style.css:167-168` (`position: fixed` big image).
- **What / why:** Horizontal scrolling on phones. In the modal, the fixed-positioned image overlaps the text column on narrow screens.
- **Fix:** Mobile-first layout with fluid grid and container widths from tokens. → F-10

### B-76 · Low · Hover transforms ignore reduced-motion preferences

- **Location:** `style.css:140-142, 306-308` (`transform: scale(1.2)`).
- **Fix:** Wrap motion in `@media (prefers-reduced-motion: no-preference)` and use token durations. → F-60

---

## CSS architecture

### B-77 · Medium · ID selectors and a universal font rule

- **Location:** IDs at `style.css:5, 18, 22, 25, 49, 135, 140, 248, 260, 272, 283`; `style.css:1-4` (`* { font-family: "Arial"; }`, no fallback stack).
- **What / why:** IDs bring very high specificity and cannot be reused. The `*` rule overrides inheritance on every element.
- **Fix:** BEM classes only (Stylelint `selector-max-id: 0`). Font set once on `:root`/`body` from a token, with the OFL font and an Arial/Helvetica fallback (PLAN). → F-61

### B-78 · Medium · Over-qualified selector chains

- **Location:** `style.css:18` (`#container > div > div > a`), `style.css:272-294` (8-level chains starting at `#main`).
- **What / why:** Any markup change breaks the styling silently, and specificity escalates.
- **Fix:** Flat BEM selectors (`selector-max-compound-selectors`, `selector-max-specificity` in Stylelint). → F-61

### B-79 · Medium · The same button style is duplicated four times

- **Location:** `style.css:81-93` (`.input button`), `98-110` (`.more`), `231-246` (`.comment-input button`), `248-263` (`#delete`); a fifth variant at `111-127` (`.fileButton`).
- **Fix:** One `.button` block with modifiers (`--primary`, `--danger`). → F-61

### B-80 · Medium · No design tokens: hard-coded colours and magic numbers

- **Location:** colours `rgb(157,…)` (`20, 65, 215`), `rgb(159,…)` (`71, 199, 223, 303`), `rgb(215,…)` (`47`), `rgb(231,…)` (`269`), `rgb(250,…)` (`183, 203`), `#f1f1f1` (`117`), `black`/`white` (many); magic numbers `87px` (`15, 132`), `52px` (`54`), `55px` (`55`), `23px` (`84, 100, 234, 250`), `-11px` (`194, 198`), `13px` (`73, 85, 102, 113, 235, 251`).
- **What / why:** Near-duplicate greys (157 vs 159) show there is no system. Theming and consistency are impossible.
- **Fix:** maw `@theme` tokens only. Stylelint forbids hard-coded colours. Spacing and sizes come from the token scale. → F-61

### B-81 · Low · Styling by element position

- **Location:** `style.css:185-200` (`.description p:first-child / :nth-child(2) / :nth-child(3)` with negative margins `-11px`).
- **What / why:** Reordering or adding an element restyles the wrong content.
- **Fix:** BEM elements (`.image-detail__title`, `__description`, `__meta`) on semantic tags. → F-61

### B-82 · Low · Dead or ineffective declarations

- **Location:** empty rule `style.css:265-266`; `object-fit` declared twice (`172-173`); `height: 100%` without a sized parent (`165`); `font-weight: 100` on Arial, which has no such weight (`124`); `text-align` on an `img` (`34`); `max-width: 30vw` on a 20 px-high icon (`138`); `height: 100vh` on `#frontview` whose content overflows (`5-8`); commented-out declarations (`33, 182, 206-208, 211`).
- **Fix:** Remove them. Stylelint `block-no-empty`, `declaration-block-no-duplicate-properties`.

### B-83 · Low · No naming methodology

- **Location:** camelCase `.fileButton`, `.imageBig`, `.commentNew` next to kebab-case `.modal-container`, `.container-right`, and generic names `.input`, `.middle`, `.more`, `.wrapper`, `.description` (throughout `style.css`).
- **Fix:** BEM per PLAN (Stylelint `selector-class-pattern`). → F-61

### B-84 · Low · Inappropriate units

- **Location:** `style.css:13-14` (horizontal padding in `vh`), mixed `px`/`vh`/`vw` without a system.
- **Fix:** Token spacing scale (`rem`), and logical properties (`padding-inline`). → F-61

---

## Project hygiene

### B-85 · Low · README without setup or licence; demo on an external host

- **Location:** `README.md:1-4` (GIF on recordit.co, a third-party host that may disappear); no LICENSE file.
- **Fix:** Portfolio README per PLAN stage 3 (screenshots in the repo, architecture diagram, setup, "What I learned"), plus a LICENSE file. → F-64

### B-86 · Medium · No tests, linting, formatting, type checking or CI

- **Location:** `package.json:6-9`.
- **Fix:** PLAN quality gate (`pnpm verify`: ESLint, Stylelint, utility-class check, typecheck, Vitest, Supertest + Testcontainers, Playwright + axe, gitleaks) and `ci.yml`.

### B-87 · Low · No health check or graceful shutdown

- **Location:** `server.js:128` (just `app.listen`); `node_modules/spiced-pg/index.js` creates a pool that is never closed.
- **What / why:** Containers cannot probe readiness. A deploy kills in-flight uploads and leaves DB connections open.
- **Fix:** `/api/health` (DB + storage), `SIGTERM` handling (`server.close`, pool end, Redis quit). → F-47

---

## Verified non-issues (keep it that way)

- **No SQL injection:** every query in `db.js` uses `$n` parameters (`db.js:36-40, 56-58, 68, 75, 83-85, 95, 103`). The rebuild uses Drizzle's parameterised builder. Raw `sql` templates must interpolate only through `sql` placeholders, never by string concatenation.
- **No DOM XSS in templates:** user content is rendered only through `{{ }}` interpolation, which Vue escapes. There is no `v-html` anywhere. The rebuild must keep it that way (ESLint `vue/no-v-html`: error). The XSS risk in the legacy app comes from uploaded files (B-05), not from the templates.
- **No N+1 queries:** the detail view makes exactly two queries (`server.js:59-63`). They run sequentially and could be parallel or joined (minor). The rebuild uses separate endpoints for the image and its comments.
- **No `!important`** in `style.css`. The new Stylelint config forbids it anyway (`declaration-no-important`).
- **Upload filenames are random** (`uid-safe`, 24 bytes, `server.js:17`), so there is no path traversal through the stored _name_. Only the _extension_ is attacker-controlled (B-05).
