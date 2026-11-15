# ADR 0004: Private bucket, keys in the database, delivery through an API media route

- Status: proposed (revised after the architecture critique, round 1)
- Date: 15 Nov 2026
- Covers: F-22, F-36, F-42, F-48; B-05, B-07, B-08, B-35, B-36

## Context

The legacy app stores absolute path-style S3 URLs (B-35), uploads with `public-read` ACLs (B-08) through an
abandoned SigV2 client (B-36), and serves attacker-controlled content types from the bucket origin (B-05).
FEATURES F-48 asks for AWS SDK v3, MinIO locally, no ACLs, and an ADR choosing between bucket policy/CDN and signed
URLs.

## Decision

- Bucket is **private** (Block Public Access on AWS, no ACLs anywhere; MinIO bucket without anonymous policy).
- DB stores only `object_key` = `images/<uuid v4>.<ext>`; `ImageDto.url = MEDIA_PUBLIC_BASE_URL + '/' + objectKey`,
  default `MEDIA_PUBLIC_BASE_URL=/api/media`.
- `GET /api/media/images/:file` and `GET /api/media/previews/:file` (upload feature; previews per ADR 0018)
  validate the file name against the key pattern, call `storage.get(key, { ifNoneMatch })` (port extended in the
  scaffold, ADR 0017), and stream the body with `stream.pipeline`. Response headers: stored `Content-Type`,
  `Content-Length`, `ETag`, `Last-Modified`, `nosniff`, `Content-Disposition: inline`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: public, max-age=86400, immutable`. `{ status: 'not-modified' }` → `304`; `ObjectNotFoundError` →
  `404`. `HEAD` is answered by the same handler (Express routes HEAD to GET); the controller writes the headers and
  destroys the S3 body stream instead of piping it.
- Media route is mounted **before** the session middleware (no Redis hit per image) with its own rate limiter.
- `@aws-sdk/client-s3` 3.1169 with `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`,
  `forcePathStyle` only when `S3_FORCE_PATH_STYLE=true` (MinIO).
- SPA CSP keeps `img-src 'self' data: blob:` because media is same-origin.

## Alternatives

- **Public-read bucket policy on the `images/` prefix**: simplest, but objects remain reachable even if a key is
  guessed after deletion races, every object is public without central control, and the bucket origin would need CSP
  allowances. Also MinIO and AWS behave differently. Rejected for now.
- **Presigned GET URLs per DTO**: no proxy traffic, but URLs change on every list request (no browser caching,
  layout flicker), expire mid-session, and leak into logs/referrers. Rejected for a gallery.
- **CDN with origin access control on the bucket**: the right production answer at scale, but the security
  headers above come from the API media route, so a CDN on the bucket would drop them (B-05 regression) unless it
  applies an equivalent response-headers policy. The supported path is a CDN in front of the **app origin**
  (caching `/api/media/*`), with `MEDIA_PUBLIC_BASE_URL` and `CSP_IMG_SRC_EXTRA` (nginx template) set together; no
  data migration (keys only in DB). Checklist in ADR 0019. The first draft's "one env var" claim was wrong.

## Consequences

- The API process carries image bytes. With ≤ 2560 px re-encoded images and a 1-day immutable cache this is
  acceptable for a portfolio project; the CDN path above is the scale-out plan.
- After delete the route returns 404 immediately (object gone). Browsers that cached the image keep it up to one
  day; a future CDN must invalidate on delete (noted for the deploy ADR).
- `media.routes.int.test.ts` covers bad keys (`../`, uppercase, wrong extension → 404 without S3 call), headers incl.
  `Content-Length`, HEAD, 304 for a matching `If-None-Match`, and 404 after delete (fake storage);
  `s3-storage.int.test.ts` proves the adapter's 304 and `NoSuchKey` mapping against MinIO.
