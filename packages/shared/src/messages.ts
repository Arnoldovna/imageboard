import { LIMITS } from './limits.js';

/**
 * User-facing strings shared by API problem details and the web UI (API.md "Field messages"). The UI switches on the
 * problem `code`, never on these texts, so wording can change without breaking a deployed client.
 */

const count = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const megabytes = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** Messages of one text field. `required` is absent for optional fields (description). */
export interface TextFieldMessages {
  readonly required?: string;
  readonly tooLong: string;
  /** Forbidden characters (line breaks in single-line fields, control characters in multi-line ones). */
  readonly invalid: string;
}

const tooLong = (label: string, max: number): string => `${label} must be ${count.format(max)} characters or fewer.`;

export const fieldMessages = {
  authorName: {
    required: 'Enter a name.',
    tooLong: tooLong('Name', LIMITS.authorName.max),
    invalid: 'Name must be on one line.',
  },
  title: {
    required: 'Enter a title.',
    tooLong: tooLong('Title', LIMITS.title.max),
    invalid: 'Title must be on one line.',
  },
  description: {
    tooLong: tooLong('Description', LIMITS.description.max),
    invalid: 'Description contains characters that are not allowed.',
  },
  commentBody: {
    required: 'Write a comment.',
    tooLong: tooLong('Comment', LIMITS.commentBody.max),
    invalid: 'Comment contains characters that are not allowed.',
  },
} as const satisfies Record<string, TextFieldMessages>;

/** "5 MB" for 5 MiB. Labelled MB because that is what people read in file managers and upload hints. */
export function formatMegabytes(bytes: number): string {
  return `${megabytes.format(bytes / (1024 * 1024))} MB`;
}

export const fileMessages = {
  required: 'Choose an image to upload.',
  unsupportedType: 'Only JPEG, PNG, WebP or GIF images are allowed.',
  unreadable: 'The image could not be read.',
  tooManyPixels: 'The image is too large to process.',
} as const;

/** 413 for an image above UPLOAD_MAX_BYTES (F-20). */
export function uploadTooLarge(maxBytes: number): string {
  return `The image must be ${formatMegabytes(maxBytes)} or smaller.`;
}

/** 400 for an animation above UPLOAD_MAX_FRAMES. */
export function animationTooLong(maxFrames: number): string {
  return `Animated images can have at most ${count.format(maxFrames)} frames.`;
}

/** Client-only codes `network` and `unexpected-response` (API.md §0). */
export const serviceUnavailable = 'The service is not available right now. Try again in a moment.';

/** Messages for request parts that are not one of the text fields above. */
export const requestMessages = {
  invalidId: 'The id must be a whole number between 1 and 2147483647.',
  invalidLimit: 'The limit must be a whole number.',
  invalidCursor: 'The pagination cursor is invalid.',
  unknownField: 'This field is not allowed.',
  invalidValue: 'This value is not valid.',
  fieldTooLong: 'This field is too long.',
  jsonBodyTooLarge: 'The request body must be 16 KB or smaller.',
  jsonRequired: 'Send the request body as application/json.',
  multipartRequired: 'Send the upload as multipart/form-data.',
  malformed: 'The request could not be read.',
} as const;

/** Ownership failures name what was deleted (API.md §2, §3). */
export const notOwnerMessages = {
  image: 'You can only delete images you uploaded.',
  comment: 'You can only delete comments you wrote.',
} as const;
