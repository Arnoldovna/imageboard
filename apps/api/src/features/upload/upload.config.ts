import type { ImageMimeType } from '@app/shared';
import type { GifOptions, JpegOptions, PngOptions, WebpOptions } from 'sharp';

/*
 * Fixed settings of the upload feature (ADR 0004, 0005, 0008, 0018). The limits that operators tune come from the
 * environment through `UploadConfig` (index.ts); everything here is a product decision, changed in an ADR first.
 */

/**
 * The limits the image processor enforces: the operator-tuned ones from `UploadConfig` plus the product limit
 * `MAX_ANIMATION_PIXELS`, which the module adds (index.ts).
 */
export interface ImageLimits {
  /** UPLOAD_MAX_PIXELS: width × height of one frame. */
  maxPixels: number;
  /** UPLOAD_MAX_FRAMES: frames of an animated GIF or WebP. */
  maxFrames: number;
  /** IMAGE_MAX_EDGE: the stored original fits inside a square of this size. */
  maxEdge: number;
  /** MAX_ANIMATION_PIXELS: pixels of all decoded frames of an animation together. */
  maxAnimationPixels: number;
}

/**
 * Decompression-bomb budget for an animation (ADR 0005): the pixels of all its decoded frames together. The per-frame
 * limit and the frame cap alone allow 200 frames of 40 MP, and repeated frames compress to almost nothing (a
 * 6000 × 6000 lossless WebP frame takes 1.4 KB), so such a file fits far below UPLOAD_MAX_BYTES and costs minutes of
 * CPU. 100 MP keeps ordinary animations (640 × 480 × 150 frames ≈ 46 MP) and bounds the work per upload, which is
 * mostly re-encoding every frame, at about 15 s of CPU (measured in ADR 0005). A still image is bounded by
 * UPLOAD_MAX_PIXELS alone. Fixed on purpose, not an environment variable: it is the denial-of-service bound, and a
 * higher UPLOAD_MAX_PIXELS does not raise it.
 */
export const MAX_ANIMATION_PIXELS = 100_000_000;

/** Same-format re-encode of the original (ADR 0005). No `keepMetadata()`/`withMetadata()`: EXIF, XMP, IPTC go. */
export const ENCODERS = {
  jpeg: { quality: 82, mozjpeg: true },
  png: { compressionLevel: 9 },
  webp: { quality: 82 },
  gif: {},
} as const satisfies { jpeg: JpegOptions; png: PngOptions; webp: WebpOptions; gif: GifOptions };

/** Types whose frames are all decoded and re-encoded. APNG is read as its first frame and stored as a static PNG. */
export const ANIMATED_TYPES: ReadonlySet<ImageMimeType> = new Set<ImageMimeType>(['image/gif', 'image/webp']);

/** The one preview rendition for gallery tiles (ADR 0018): first frame, inside 960 px, WebP q75, no metadata. */
export const PREVIEW = {
  maxEdge: 960,
  quality: 75,
  contentType: 'image/webp',
} as const;

/**
 * Deleting stored objects (ADR 0008): up to 3 attempts per key; the waits before the second and third attempt grow
 * exponentially (×4). A key that still fails is an orphan, logged at `error` for ops, never a client error.
 */
export const DISCARD_RETRY = {
  attempts: 3,
  delaysMs: [100, 400],
} as const;

/** Response headers of the media route (ADR 0004, API.md §4). */
export const MEDIA_HEADERS = {
  cacheControl: 'public, max-age=86400, immutable',
  contentSecurityPolicy: "default-src 'none'; sandbox",
  crossOriginResourcePolicy: 'same-origin',
  contentDisposition: 'inline',
} as const;
