import { IMAGE_MIME_TYPES, type ImageMimeType } from '@app/shared';
import { fileTypeFromBuffer } from 'file-type';

import { UnsupportedImageTypeError } from '../../shared/errors/app-error.js';

const ALLOWED: ReadonlySet<string> = new Set<string>(IMAGE_MIME_TYPES);

/** file-type reports animated PNGs as `image/apng`; the API accepts them as PNG (F-19, FEATURES §14 R-07). */
const ALIASES: ReadonlyMap<string, ImageMimeType> = new Map([['image/apng', 'image/png']]);

function isImageMimeType(mime: string): mime is ImageMimeType {
  return ALLOWED.has(mime);
}

/**
 * The image type from the magic bytes (F-19, B-04, B-05). The client's filename and Content-Type are never an input:
 * this function only sees the bytes. Anything other than JPEG, PNG (incl. APNG), WebP or GIF is
 * `415 unsupported-image-type`, before anything is decoded or stored.
 */
export async function sniffImageType(bytes: Uint8Array): Promise<ImageMimeType> {
  const detected = await fileTypeFromBuffer(bytes);
  if (detected === undefined) throw new UnsupportedImageTypeError();
  const mime = ALIASES.get(detected.mime) ?? detected.mime;
  if (!isImageMimeType(mime)) throw new UnsupportedImageTypeError();
  return mime;
}
