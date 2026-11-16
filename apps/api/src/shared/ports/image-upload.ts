import type { ImageMimeType } from '@app/shared';

/*
 * The port between the images feature and the upload feature (ADR 0017, frozen). The composition root passes the
 * upload module's implementation to the images module; images tests pass a fake. Types only.
 */

/** What the images controller hands over: never the client filename or client MIME type. */
export interface IncomingFile {
  buffer: Buffer;
  size: number;
}

export interface StoredImage {
  objectKey: string; // images/<uuid v4>.<jpg|png|webp|gif>
  mimeType: ImageMimeType; // detected
  width: number;
  height: number;
  sizeBytes: number;
}

export interface IngestOptions {
  /** Seed only: fixed key from manifest.json; must match MEDIA_KEY_PATTERN and the detected extension. */
  objectKey?: string;
}

export interface ImageUploadPort {
  /** sniff → decode/normalise → put original + preview (ADR 0018). Throws UnsupportedImageTypeError (415) or
   *  InvalidImageError (400); nothing remains stored when it throws. */
  ingest(file: IncomingFile, options?: IngestOptions): Promise<StoredImage>;
  /** Deletes original and preview; 3 attempts with backoff; never throws; logs an orphan at error. */
  discard(objectKey: string): Promise<void>;
  publicUrl(objectKey: string): string; // `${MEDIA_PUBLIC_BASE_URL}/${objectKey}`
  previewUrl(objectKey: string): string; // `${MEDIA_PUBLIC_BASE_URL}/previews/<uuid>.webp`
}
