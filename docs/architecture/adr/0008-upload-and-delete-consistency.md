# ADR 0008: Consistency between database and object storage

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-23, F-36, F-D2; B-07, B-17, B-19, B-22, B-25

## Context

S3 and Postgres cannot share a transaction. The legacy app uploads before validating (orphans, B-25), never deletes
objects (B-07), and deletes rows in two unawaited, non-transactional steps (B-22).

## Decision

**Create** (`images.service.create`):
1. Everything that can fail cheaply happens first (fields, sniff, decode) — nothing stored yet.
2. `PutObject` original, then preview (ADR 0018). If either fails: anything already put is discarded, throw, no
   row.
3. `INSERT … RETURNING`. If it fails: `upload.discard(key)` (awaited), then rethrow the original error.
4. Never hold a DB transaction open across the S3 call.

**Delete image** (`images.service.remove`):
1. `DELETE FROM images WHERE id = $1 AND owner_id = $2 RETURNING object_key` — one atomic statement; comments go by
   `ON DELETE CASCADE`.
2. Zero rows → `exists(id)` → `404 not-found` or `403 not-owner`.
3. After the statement has committed: `upload.discard(objectKey)` deletes original and preview, each with up to 3
   attempts (100 ms, 400 ms, 1.6 s backoff). A final failure logs `error` `{ objectKey, failedKeys, attempts }` and
   **does not** fail the request: the image is already gone from the product; the orphan is an ops concern.
4. `204`.

**Delete comment**: same pattern without storage.

## Alternatives

- **Outbox table + worker** for object deletion: robust, but a worker process for a portfolio-sized app is
  over-engineering. Logged orphans can be cleaned with a one-off script if they ever occur. Revisit if deploys
  show orphans.
- **Delete object first, then row**: a DB failure would leave a row pointing to a missing object (broken image in
  the UI). Worse than an orphaned object.
- **Bucket lifecycle rule on untagged objects** (tag on successful insert): doubles S3 calls per upload; deferred.

## Consequences

- Unit tests (fake storage and repository) cover: insert failure → discard called; put failure → no insert;
  discard failure → logged, request still 204.
- Integration tests prove: after delete, comments count 0, `GET` 404, media 404 for original and preview, fake
  storage empty.
- The media route may briefly serve a deleted image during the retry window (≤ 2 s); acceptable.
