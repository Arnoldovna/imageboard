import { fileMessages, IMAGE_MIME_TYPES, uploadTooLarge, type ImageMimeType } from '@app/shared';

import { sniffImageType } from '../../shared/files/image-type';

/**
 * Client-side check of the chosen image before anything is sent (F-20, B-54 item 3). It applies the server's rules
 * with the server's messages, so a rejected file reads the same here as in a `413`/`415` problem:
 * - the type comes from the file's first bytes (magic numbers), like the API's sniffing (F-19), not from the name or
 *   the browser's guessed MIME type, so a renamed SVG or PDF is caught here already;
 * - the size limit is the session's `uploadMaxBytes`.
 *
 * The API still decides: this check only spares people a slow round trip with a file that cannot succeed.
 */

/** The `accept` attribute of the file input: a hint for the system picker, never a check. */
export const ACCEPTED_IMAGE_TYPES = IMAGE_MIME_TYPES.join(',');

/** "JPEG, PNG, WebP or GIF" in the order of the shared message. */
export const ACCEPTED_IMAGE_LABEL = 'JPEG, PNG, WebP or GIF';

/** Enough bytes for every signature `sniffImageType` checks (WebP needs 12). */
const SNIFF_BYTES = 12;

/** What the picker and the form need to know about a file: a message for people, or the detected type. */
export type FileCheckResult = { ok: true; type: ImageMimeType } | { ok: false; message: string };

/**
 * Checks type first, then size: a PDF is the wrong file at any size, so "make it smaller" would mislead.
 * An empty or unreadable file gets the API's "could not be read" message.
 */
export async function checkImageFile(file: Blob, maxBytes: number): Promise<FileCheckResult> {
  if (file.size === 0) return { ok: false, message: fileMessages.unreadable };

  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    // The file was moved or deleted after it was chosen, or the browser denied access.
    return { ok: false, message: fileMessages.unreadable };
  }

  const type = sniffImageType(head);
  if (type === null) return { ok: false, message: fileMessages.unsupportedType };
  if (file.size > maxBytes) return { ok: false, message: uploadTooLarge(maxBytes) };
  return { ok: true, type };
}
