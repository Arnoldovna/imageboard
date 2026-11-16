import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Upload fixtures for e2e specs (OVERVIEW §14, ADR 0015).
 *
 * The committed images in `e2e/fixtures/` are tiny flat-colour files generated once for this repository (no
 * photographs, no third-party content, no metadata): `landscape.jpg` was encoded from a generated PNG and its APP1..15
 * segments (Exif, IPTC) were stripped; `portrait.png` has only IHDR/IDAT/IEND; `square.gif` is a single frame.
 * `not-an-image.png` is HTML with a `.png` name (B-04, B-05: the API must reject it by content).
 *
 * Every value has the shape Playwright accepts both for `locator.setInputFiles()` and for a multipart part of
 * `request.post(url, { multipart })`, so the same fixture drives the UI and the API helpers in `support/api.ts`.
 */
export interface FixtureFile {
  /** Client filename. The API never uses it for storage (F-21); the upload form shows it (F-24). */
  name: string;
  /** Client-declared MIME type. The API ignores it and sniffs the content (F-19). */
  mimeType: string;
  buffer: Buffer;
}

/** A decodable image fixture together with its pixel size, which the API stores and the gallery reserves (F-09). */
export interface ImageFixture extends FixtureFile {
  width: number;
  height: number;
}

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

const IMAGES = {
  landscapeJpeg: { name: 'landscape.jpg', mimeType: 'image/jpeg', width: 120, height: 80 },
  portraitPng: { name: 'portrait.png', mimeType: 'image/png', width: 60, height: 90 },
  squareGif: { name: 'square.gif', mimeType: 'image/gif', width: 40, height: 40 },
} as const satisfies Record<string, Omit<ImageFixture, 'buffer'>>;

export type ImageFixtureName = keyof typeof IMAGES;

/** Names of all image fixtures, e.g. to upload one of each type. */
export const IMAGE_FIXTURE_NAMES = Object.keys(IMAGES) as ImageFixtureName[];

function readFixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

/** One of the committed images. Each call returns a fresh buffer, so a spec may modify it freely. */
export function imageFixture(name: ImageFixtureName = 'landscapeJpeg'): ImageFixture {
  const meta = IMAGES[name];
  return { ...meta, buffer: readFixture(meta.name) };
}

/** HTML disguised as a PNG: the right extension and client MIME type, the wrong content (F-19, B-04, B-05). */
export function notAnImage(): FixtureFile {
  return { name: 'not-an-image.png', mimeType: 'image/png', buffer: readFixture('not-an-image.png') };
}

/**
 * `big.jpg`: a real JPEG (the landscape fixture) padded with zero bytes after its end-of-image marker to exactly
 * `sizeBytes`. Content sniffing still sees a JPEG, so only the size can reject it (F-20). Pass
 * `session.uploadMaxBytes + 1` (from `getSessionViaApi`) to land one byte over the effective limit.
 */
export function bigJpeg(sizeBytes: number): FixtureFile {
  const jpeg = readFixture(IMAGES.landscapeJpeg.name);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < jpeg.length) {
    throw new RangeError(`bigJpeg: sizeBytes must be an integer >= ${String(jpeg.length)}, got ${String(sizeBytes)}`);
  }
  const buffer = Buffer.alloc(sizeBytes);
  jpeg.copy(buffer);
  return { name: 'big.jpg', mimeType: 'image/jpeg', buffer };
}
