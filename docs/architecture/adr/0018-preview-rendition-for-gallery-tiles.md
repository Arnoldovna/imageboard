# ADR 0018: One preview rendition for gallery tiles

- Status: proposed (added after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-09, F-22 (annotated), FEATURES §13 ("An ADR may add thumbnails if performance requires them")

## Context

The first draft served the stored original (up to 2560 px; re-encoded PNGs can be several MB) to fill tiles that are
about 300 CSS px wide, 12 or more per page. For a portfolio demo that is judged by first impressions and Lighthouse,
the gallery would be the slowest page in the app. FEATURES §13 excludes "server-side thumbnails in several sizes" but
explicitly allows an ADR to add thumbnails if performance requires them.

## Decision

- At ingest, after the original has been normalised, the upload feature also renders **one preview**: first frame
  only (`pages: 1`), `.resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })`, WebP
  `{ quality: 75 }`, no metadata. 960 px covers a 1-column tile on a 390 px phone at 2.5× density and a 4-column tile
  at 3×.
- **Key is derived, not stored**: `images/<uuid>.<ext>` → `previews/<uuid>.webp`. No schema change; the DB still
  stores only `object_key` (B-35). `ImageUploadPort.previewUrl(objectKey)` builds the URL (ADR 0017).
- Order inside `ingest`: put original → put preview; if either put fails, both keys are discarded (a timed-out put may
  still have stored its object) before rethrowing, so a failed ingest leaves nothing behind (ADR 0008 unchanged in spirit). `discard(objectKey)` deletes
  both keys (each with the retry policy) and logs `{ objectKeys, attempts }` on final failure.
- `ImageDto` gains `previewUrl`. Gallery tiles use `previewUrl`; the detail dialog uses `url` (the original,
  animated if the original is animated). Tiles keep `width`/`height` of the original as attributes (same aspect
  ratio), so CLS is unaffected.
- Media route: `GET /api/media/previews/:file` with pattern `^<uuid v4>\.webp$`, same headers and limiter as
  originals. Two literal routes (`/images/:file`, `/previews/:file`) because Express 5 (path-to-regexp 8) has no
  inline regex parameters.
- Seed images get previews through the same `ingest` call (fixed key option), so `db:seed` stores 32 objects.

## Alternatives

- **Lower `IMAGE_MAX_EDGE` to 1600**: halves pixel count but PNG originals stay large and tiles still download 4×
  more pixels than they show. Rejected as the main fix (seeds are already ≤ 1600 px).
- **`srcset` with several sizes**: what §13 excludes; one rendition is enough for a fixed-width grid.
- **On-the-fly resizing in the media route** (sharp per request, cached): CPU per request and a cache to manage.
  Rejected.
- **Store `preview_key` in the DB**: redundant while the key is a pure function of `object_key`.

## Consequences

- Each upload does one more sharp pass (≈ 50 ms) and one more `PutObject`; storage grows by roughly 5–10 %.
- `image-processor.test.ts` asserts preview format, bounds, first-frame-only for animated input and metadata
  absence; `upload-flow.int.test.ts` asserts both objects exist after upload and both are gone after delete;
  `media.routes.int.test.ts` covers the preview pattern.
- FEATURES F-22 ("stored object's Content-Type equals the detected type") stays true for the original; the preview
  is a derived rendition and is always `image/webp`. The annotation is in FEATURES.
