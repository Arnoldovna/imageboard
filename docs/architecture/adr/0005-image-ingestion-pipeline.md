# ADR 0005: Image ingestion: memory multipart, magic-byte allow-list, sharp re-encode

- Status: proposed (revised after the architecture critique, round 1; animation pixel budget added in the final
  security audit, 16 Nov 2026)
- Date: 15 Nov 2026
- Covers: F-18 to F-23; B-04, B-05, B-06, B-11, B-19, B-20, B-24, B-25, B-34

## Context

The legacy upload accepts any file, keeps the client's extension and Content-Type (stored XSS), publishes EXIF/GPS,
stages files on disk and leaks them on errors. FEATURES requires magic-byte detection, re-encoding, metadata
stripping, 5 MiB default limit, 413/415 problems, and no stored state on validation failure.

## Decision

The multipart gate and parser live in `shared/http/multipart.ts` (scaffold, ADR 0017) so the images router runs
them; everything from "Sniff" on lives inside `features/upload` (exposed as `ImageUploadPort.ingest`):

| Step                   | Implementation                                                                                                                                                                                                                                                                                                                                                                                                | Failure                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content type gate      | `req.is('multipart/form-data')`                                                                                                                                                                                                                                                                                                                                                                               | 415 `unsupported-content-type`                                                                                                                                           |
| Parse                  | multer 2.5 `memoryStorage()`, `.single('file')`, limits `{ fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 3, fieldSize: 16384, parts: 4 }`                                                                                                                                                                                                                                                                     | 413 `payload-too-large`; `LIMIT_FIELD_VALUE` → 400 `validation-failed` on that field ("… must be N characters or fewer."); other multer errors → 400 `malformed-request` |
| Fields                 | `CreateImageFields` (shared Zod, strict) + file presence, all issues in one 400 (done by the images controller before calling `ingest`)                                                                                                                                                                                                                                                                       | 400 `validation-failed`                                                                                                                                                  |
| Sniff                  | `fileTypeFromBuffer` (file-type 22.3) ∈ `IMAGE_MIME_TYPES`; `image/apng` is treated as `image/png` (file-type reports animated PNGs as APNG)                                                                                                                                                                                                                                                                  | 415 `unsupported-image-type`                                                                                                                                             |
| Inspect                | `sharp(buffer).metadata()` (header only): `width × (pageHeight ?? height)` ≤ `UPLOAD_MAX_PIXELS` (per frame), `pages ?? 1` ≤ `UPLOAD_MAX_FRAMES` (default 200), and for an animated GIF/WebP the pixels of all decoded frames together ≤ `MAX_ANIMATION_PIXELS` (100 MP, `upload.config.ts`)                                                                                                                  | 400 `invalid-image` ("The image is too large to process." / "Animated images can have at most 200 frames." / "… at most 100 megapixels in all frames together.")         |
| Decode + normalise     | `sharp(buffer, { limitInputPixels: frameWidth × frameHeight × frames + 1, failOn: 'error', animated: mime is gif/webp })` (the limit is computed from the inspected values, because sharp applies `limitInputPixels` to the whole frame strip of an animation) → `.rotate()` (apply EXIF orientation) → `.resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })` | 400 `invalid-image` ("The image could not be read.")                                                                                                                     |
| Re-encode, same format | jpeg `{ quality: 82, mozjpeg: true }`, png `{ compressionLevel: 9 }`, webp `{ quality: 82 }`, gif `{}`; **no** `keepMetadata()/withMetadata()`, so EXIF, XMP, IPTC and GPS are dropped; ICC is converted to sRGB. APNG input is decoded by libvips as its first frame and stored as a static PNG                                                                                                              | 400 `invalid-image`                                                                                                                                                      |
| Measure                | `info.width`, `info.height` (for animated: `pageHeight`), `info.size`                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                          |
| Preview                | first frame, ≤ 960 px, WebP q75 (ADR 0018)                                                                                                                                                                                                                                                                                                                                                                    | 400 `invalid-image`                                                                                                                                                      |
| Key                    | `images/${crypto.randomUUID()}.${ext}` with ext from the detected type (`jpg`, `png`, `webp`, `gif`); preview `previews/<same uuid>.webp`                                                                                                                                                                                                                                                                     |                                                                                                                                                                          |
| Store                  | `PutObject` original with `ContentType` = detected type, then preview (`image/webp`); a failed preview put discards the original                                                                                                                                                                                                                                                                              | 500, nothing in DB                                                                                                                                                       |

Ordinary animated GIFs (for example 640×480 × 150 frames ≈ 46 megapixels in total) pass, because the pixel limit is
per frame. The per-frame limit and the frame cap alone do not bound the work, though: frames that repeat compress to
almost nothing (a solid 6000 × 6000 lossless WebP frame takes 1.4 KB), so 200 frames of 36 MP fit in about 290 KB, far
below `UPLOAD_MAX_BYTES`. The final security audit measured about 11 s of CPU and 790 MB RSS for 20 such frames, so
about 100 s for 200, from one request. A product limit therefore caps the pixels of all decoded frames of an animation
together: `MAX_ANIMATION_PIXELS` = 100 MP (`upload.config.ts`, changed in this ADR, not an environment variable). It
rejects such a file at the header check, before any pixel is decoded, with its own message ("Animated images can have
at most 100 megapixels in all frames together."), because every single frame may be within `UPLOAD_MAX_PIXELS`. It
keeps the 46 MP example and bounds the work per upload; the cost of what it allows is under Consequences. Still images
are bounded by `UPLOAD_MAX_PIXELS` alone, and raising `UPLOAD_MAX_PIXELS` does not raise this budget.

The client filename and client MIME type are never read except to produce no-op logs. The processed buffer
replaces the original; the original bytes are never stored. No temp files exist at any step.

Client side (`client-file-check.ts`): `file.type` ∈ allowed and `file.size ≤ uploadMaxBytes` (from
`SessionDto`), same messages as the server; the server stays authoritative. The file input has
`accept="image/jpeg,image/png,image/webp,image/gif"`; listing concrete types (not `image/*`) makes iOS Safari convert
HEIC photos to JPEG before handing them to the page.

## Alternatives

- **Store originals, strip EXIF with exiftool**: an external binary, and originals may be huge or malicious.
- **Convert everything to WebP**: smaller, but FEATURES F-22 requires the stored type to equal the detected type and
  animated GIF fidelity varies. Kept as a possible later ADR.
- **Disk storage + streaming**: needed only for very large files; 5 MiB in memory is bounded by the limits and the
  upload rate limit (10/h/IP).
- **Thumbnails in several sizes**: out of scope (FEATURES §13). One preview rendition is added by ADR 0018.
- **Reject APNG with a dedicated message**: technically honest, but users see "PNG" in their file manager. Accepting
  it as a static PNG is friendlier and safe (the same decoder and re-encode run).

## Consequences

- `sharp` 0.35.5 joins the API deps; it ships prebuilt libvips for glibc (works on `node:26-slim` and distroless
  debian13) and has no install script, so `onlyBuiltDependencies` does not change.
- CPU per upload is a few hundred ms for a photo. Animations cost more, because every frame is re-encoded, and the
  re-encode, not the decode, dominates. Measured with the solid-frame fixtures on a 2019 laptop CPU (Intel
  i9-9980HK): the 46 MP example (640 × 480 × 150 frames) takes about 6 s of CPU as GIF and 8 s as WebP; the most
  expensive shapes the 100 MP budget allows (many frames small enough to need no shrinking, for example 200 frames of
  707 × 707) take 13 to 17 s; few huge frames are cheaper (3 × 33 MP: about 5 s, because they shrink to 2560 px
  first). sharp runs on the libuv thread pool, so the event loop stays responsive. The upload limits bound the total:
  10 uploads/hour/IP and 200/day in all (ADR 0013), so at most about an hour of CPU per day even if every upload
  were a worst case.
- Test fixtures are hand-encoded in `test/fixtures.ts` with Node built-ins only (baseline JPEG with GPS EXIF and
  orientation 6, zlib PNG and APNG, lossless VP8L WebP, LZW-encoded animated GIF with 150 small frames and a GIF with
  201 frames, animated WebP of solid VP8L frames for the animation budget), plus byte fixtures for SVG, HTML named `.png`, PDF and a 6 MiB buffer. Test inputs therefore never
  depend on the library under test (sharp); they were checked with file-type and an independent decoder. Nothing
  binary from legacy.
