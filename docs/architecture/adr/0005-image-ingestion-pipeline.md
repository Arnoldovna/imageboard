# ADR 0005: Image ingestion: memory multipart, magic-byte allow-list, sharp re-encode

- Status: proposed (revised after the architecture critique, round 1)
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
| Inspect                | `sharp(buffer).metadata()` (header only): `width × (pageHeight ?? height)` ≤ `UPLOAD_MAX_PIXELS` (per frame), `pages ?? 1` ≤ `UPLOAD_MAX_FRAMES` (default 200)                                                                                                                                                                                                                                                | 400 `invalid-image` ("The image is too large to process." / "Animated images can have at most 200 frames.")                                                              |
| Decode + normalise     | `sharp(buffer, { limitInputPixels: frameWidth × frameHeight × frames + 1, failOn: 'error', animated: mime is gif/webp })` (the limit is computed from the inspected values, because sharp applies `limitInputPixels` to the whole frame strip of an animation) → `.rotate()` (apply EXIF orientation) → `.resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })` | 400 `invalid-image` ("The image could not be read.")                                                                                                                     |
| Re-encode, same format | jpeg `{ quality: 82, mozjpeg: true }`, png `{ compressionLevel: 9 }`, webp `{ quality: 82 }`, gif `{}`; **no** `keepMetadata()/withMetadata()`, so EXIF, XMP, IPTC and GPS are dropped; ICC is converted to sRGB. APNG input is decoded by libvips as its first frame and stored as a static PNG                                                                                                              | 400 `invalid-image`                                                                                                                                                      |
| Measure                | `info.width`, `info.height` (for animated: `pageHeight`), `info.size`                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                          |
| Preview                | first frame, ≤ 960 px, WebP q75 (ADR 0018)                                                                                                                                                                                                                                                                                                                                                                    | 400 `invalid-image`                                                                                                                                                      |
| Key                    | `images/${crypto.randomUUID()}.${ext}` with ext from the detected type (`jpg`, `png`, `webp`, `gif`); preview `previews/<same uuid>.webp`                                                                                                                                                                                                                                                                     |                                                                                                                                                                          |
| Store                  | `PutObject` original with `ContentType` = detected type, then preview (`image/webp`); a failed preview put discards the original                                                                                                                                                                                                                                                                              | 500, nothing in DB                                                                                                                                                       |

Ordinary animated GIFs (for example 640×480 × 150 frames ≈ 46 megapixels in total) pass, because the pixel limit is
per frame; the frame cap and the per-frame limit together bound memory (200 × 40 MP is the theoretical maximum, but
`UPLOAD_MAX_BYTES` makes such inputs impossible in practice for compressed formats).

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
- CPU per upload is a few hundred ms at most; acceptable at 10 uploads/hour/IP.
- Test fixtures are hand-encoded in `test/fixtures.ts` with Node built-ins only (baseline JPEG with GPS EXIF and
  orientation 6, zlib PNG and APNG, lossless VP8L WebP, LZW-encoded animated GIF with 150 small frames and a GIF with
  201 frames), plus byte fixtures for SVG, HTML named `.png`, PDF and a 6 MiB buffer. Test inputs therefore never
  depend on the library under test (sharp); they were checked with file-type and an independent decoder. Nothing
  binary from legacy.
