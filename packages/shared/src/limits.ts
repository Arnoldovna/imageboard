/**
 * Every number the API, the database CHECK constraints and the web app agree on (B-30). The Drizzle schema imports
 * these values, so a change here shows up as schema drift until a new migration is generated (DATA-MODEL §2).
 */
export const LIMITS = {
  /** Display name next to an image or comment, in code points (F-18, F-29). */
  authorName: { min: 1, max: 60 },
  title: { min: 1, max: 120 },
  description: { min: 0, max: 2000 },
  commentBody: { min: 1, max: 1000 },
  /** Gallery page size: 12 fits 2, 3 and 4 columns (F-02). */
  imagesPage: { default: 12, max: 50 },
  commentsPage: { default: 20, max: 50 },
  /** Largest Postgres `integer`, the upper bound of every public id (F-44). */
  maxId: 2_147_483_647,
  cursorMaxLength: 200,
  /** JSON request bodies (comments), as body-parser's `limit` in the API (API.md §0, F-49). */
  jsonBodyMaxBytes: 16 * 1024,
  /** Default of UPLOAD_MAX_BYTES (5 MiB). The server sends the effective value in `SessionDto.uploadMaxBytes`. */
  uploadMaxBytesDefault: 5 * 1024 * 1024,
  /** Default of UPLOAD_MAX_FRAMES for animated GIF/WebP. */
  uploadMaxFramesDefault: 200,
} as const;

/** Image types the API stores, detected from the file content (F-19). APNG is stored as a static PNG. */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
