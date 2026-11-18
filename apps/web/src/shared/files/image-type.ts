import type { ImageMimeType } from '@app/shared';

/*
 * Magic numbers of the four image types the API stores (F-19), on the client: the upload form's pre-check
 * (features/upload/client-file-check.ts) and the live demo's in-browser API (src/demo/) both sniff with this.
 */

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => Array.from(text, (character) => character.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87A = ascii('GIF87a');
const GIF89A = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');

/** The image type of a file's first bytes, or `null` when it is none of the four the API stores. */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) return 'image/gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}
