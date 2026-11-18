import {
  CommentDto,
  CommentPage,
  CreateCommentBody,
  CreateImageFields,
  CursorPayload,
  type FieldError,
  type FieldErrorLocation,
  fileMessages,
  IdParam,
  ImageDto,
  ImagePage,
  type IssueLike,
  LIMITS,
  notOwnerMessages,
  pageQuery,
  type ProblemCode,
  problemMessages,
  requestMessages,
  SessionDto,
  toFieldErrors,
  uploadTooLarge,
} from '@app/shared';
import { http, type HttpHandler, HttpResponse, type PathParams } from 'msw';

import { sniffImageType } from '../shared/files/image-type';
import { type CommentRecord, type DemoStore, type ImageRecord, MissingImageError } from './demo-store';

/*
 * The API of the live demo, answered in the browser by Mock Service Worker (PLAN Etappe 3b). It follows
 * docs/architecture/API.md with the shared Zod contract: the same request schemas (strict: unknown keys are a 400), the
 * same problem codes and messages, CSRF on every mutation, ownership checks, keyset pagination and the same response
 * DTOs (every body is parsed with its shared schema before it is sent). What a static page cannot do is left out:
 * rate limits, sessions that expire, previews rendered by sharp (the original doubles as the preview) and the frame
 * and pixel limits for animations.
 */

export interface ImageSize {
  width: number;
  height: number;
}

export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export interface DemoApiOptions {
  store: DemoStore;
  /** Decodes an upload and returns its size; rejects when the browser cannot read the image ("invalid-image"). */
  readImageSize: (blob: Blob) => Promise<ImageSize>;
  /** Default: `URL.createObjectURL` / `URL.revokeObjectURL`. Uploaded images are shown from `blob:` URLs. */
  objectUrls?: ObjectUrls;
  /** Default: the current time. */
  now?: () => Date;
  /** Default: `crypto.randomUUID`. */
  newCsrfToken?: () => string;
  /** Default: the API's UPLOAD_MAX_BYTES default (5 MiB). */
  uploadMaxBytes?: number;
}

/** Same tag URI scheme as the API (apps/api/src/shared/http/problem.ts). */
const PROBLEM_TYPE_PREFIX = 'tag:arnoldovna.github.io,2026:imageboard:problem:';

const imagesQuery = pageQuery(LIMITS.imagesPage.default, LIMITS.imagesPage.max);
const commentsQuery = pageQuery(LIMITS.commentsPage.default, LIMITS.commentsPage.max);

// ------------------------------------------------------------------------------------------------ problems

/** Status and title per code, as the API's `AppError` classes send them (apps/api/src/shared/errors/app-error.ts). */
const PROBLEM_STATUS: Readonly<Record<ProblemCode, { status: number; title: string }>> = {
  'validation-failed': { status: 400, title: 'Validation failed' },
  'invalid-cursor': { status: 400, title: 'Invalid cursor' },
  'malformed-request': { status: 400, title: 'Malformed request' },
  'invalid-image': { status: 400, title: 'Invalid image' },
  'csrf-invalid': { status: 403, title: 'Forbidden' },
  'cross-origin-request': { status: 403, title: 'Forbidden' },
  'session-required': { status: 403, title: 'Forbidden' },
  'not-owner': { status: 403, title: 'Forbidden' },
  'not-found': { status: 404, title: 'Not found' },
  'payload-too-large': { status: 413, title: 'Payload too large' },
  'unsupported-image-type': { status: 415, title: 'Unsupported image type' },
  'unsupported-content-type': { status: 415, title: 'Unsupported media type' },
  'rate-limited': { status: 429, title: 'Too many requests' },
  'internal-error': { status: 500, title: 'Internal server error' },
};

/** A problem response to send; thrown by the handlers and turned into problem+json by `route`. */
class Problem extends Error {
  readonly code: ProblemCode;
  readonly errors: readonly FieldError[] | undefined;

  constructor(code: ProblemCode, detail: string = problemMessages[code], errors?: readonly FieldError[]) {
    super(detail);
    this.code = code;
    this.errors = errors;
  }
}

const notFound = (resource: string) => new Problem('not-found', `${resource} was not found.`);

function problemResponse(problem: Problem, request: Request): Response {
  const url = new URL(request.url);
  const { status, title } = PROBLEM_STATUS[problem.code];
  const body = {
    type: `${PROBLEM_TYPE_PREFIX}${problem.code}`,
    title,
    status,
    detail: problem.message,
    instance: `${url.pathname}${url.search}`,
    code: problem.code,
    requestId: crypto.randomUUID(),
    ...(problem.errors === undefined ? {} : { errors: problem.errors }),
  };
  return new HttpResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

type Resolver = (info: { request: Request; params: PathParams }) => Promise<Response>;

/** Express' error handler in small: a `Problem` becomes its response, anything else `500 internal-error`. */
function route(resolver: Resolver): Resolver {
  return async (info) => {
    try {
      return await resolver(info);
    } catch (error) {
      const problem = error instanceof Problem ? error : new Problem('internal-error');
      return problemResponse(problem, info.request);
    }
  };
}

// ------------------------------------------------------------------------------------------------ validation

interface ParseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: readonly IssueLike[] } };
}

const validationFailed = (errors: readonly FieldError[]) => new Problem('validation-failed', undefined, errors);

function parseOrThrow<T>(schema: ParseSchema<T>, value: unknown, location: FieldErrorLocation, rootField?: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationFailed(toFieldErrors(location, result.error.issues, rootField));
  return result.data;
}

const pathId = (params: PathParams, name: string): number => parseOrThrow(IdParam, params[name], 'params', name);

type Fields = Record<string, string | string[]>;

/** Like Express' query parser and multer: a repeated key becomes an array (which the strict schemas then reject). */
function addField(fields: Fields, key: string, value: string): void {
  const previous = fields[key];
  fields[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
}

function queryOf(request: Request): Fields {
  const query: Fields = {};
  for (const [key, value] of new URL(request.url).searchParams) addField(query, key, value);
  return query;
}

// ------------------------------------------------------------------------------------------------ pagination

interface KeysetPosition {
  createdAt: string;
  id: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Opaque base64url JSON `{ t, id }` like the API's cursor (ADR 0007). */
export function encodeCursor({ createdAt, id }: KeysetPosition): string {
  return btoa(JSON.stringify({ t: createdAt, id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Any cursor that does not decode to the shared `CursorPayload` is `400 invalid-cursor`, never a 500. */
export function decodeCursor(raw: string): KeysetPosition {
  const invalid = new Problem('invalid-cursor');
  if (!BASE64URL.test(raw)) throw invalid;
  let json: unknown;
  try {
    json = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    throw invalid;
  }
  const payload = CursorPayload.safeParse(json);
  if (!payload.success) throw invalid;
  return { createdAt: payload.data.t, id: payload.data.id };
}

/** Keyset page over rows sorted `created_at DESC, id DESC`: strictly older than the cursor, `limit + 1` probe. */
function pageOf<T extends KeysetPosition>(rows: readonly T[], limit: number, cursor: string | undefined) {
  const position = cursor === undefined ? undefined : decodeCursor(cursor);
  const older =
    position === undefined
      ? rows
      : rows.filter(
          (row) => row.createdAt < position.createdAt || (row.createdAt === position.createdAt && row.id < position.id),
        );
  const items = older.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: older.length > limit && last !== undefined ? encodeCursor(last) : null };
}

// ------------------------------------------------------------------------------------------------ uploads

interface UploadParts {
  fields: Fields;
  file: File | undefined;
}

/** multer's rules (API.md §2): exactly one file part named `file`; text parts become fields. */
function splitParts(form: FormData): UploadParts {
  const fields: Fields = {};
  let file: File | undefined;
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      addField(fields, name, value);
    } else if (name !== 'file' || file !== undefined) {
      throw new Problem('malformed-request', requestMessages.malformed);
    } else {
      file = value;
    }
  }
  return { fields, file };
}

// ------------------------------------------------------------------------------------------------ handlers

export function createDemoHandlers(options: DemoApiOptions): HttpHandler[] {
  const {
    store,
    readImageSize,
    objectUrls = {
      create: (blob) => URL.createObjectURL(blob),
      revoke: (url) => {
        URL.revokeObjectURL(url);
      },
    },
    now = () => new Date(),
    newCsrfToken = () => crypto.randomUUID(),
    uploadMaxBytes = LIMITS.uploadMaxBytesDefault,
  } = options;

  // One token per page load, like a session that lives as long as the tab (ADR 0003's double submit in small).
  const csrfToken = newCsrfToken();
  /** `blob:` URLs of uploaded images, created on first use and revoked when the image is deleted. */
  const uploadUrls = new Map<string, string>();
  /**
   * Ids alone are not unique over the tab's lifetime: a reset in another tab starts them again after the seed, so a
   * new upload can reuse an id this tab has cached. The upload time tells the two apart.
   */
  const uploadKey = (image: ImageRecord) => `${String(image.id)}@${image.createdAt}`;

  function requireCsrf(request: Request): void {
    if (request.headers.get('x-csrf-token') !== csrfToken) {
      throw new Problem('csrf-invalid');
    }
  }

  async function urlOf(image: ImageRecord): Promise<string> {
    if (image.url !== null) return image.url;
    const cached = uploadUrls.get(uploadKey(image));
    if (cached !== undefined) return cached;
    const file = await store.file(image.id);
    if (file === undefined) throw new Error(`The file of image ${String(image.id)} is missing.`);
    const url = objectUrls.create(new Blob([file.bytes], { type: file.type }));
    uploadUrls.set(uploadKey(image), url);
    return url;
  }

  async function imageDto(image: ImageRecord, ownerId: string): Promise<ImageDto> {
    const url = await urlOf(image);
    return ImageDto.parse({
      id: image.id,
      url,
      previewUrl: url,
      width: image.width,
      height: image.height,
      mimeType: image.mimeType,
      authorName: image.authorName,
      title: image.title,
      description: image.description,
      createdAt: image.createdAt,
      canDelete: image.ownerId === ownerId,
    });
  }

  const commentDto = (comment: CommentRecord, ownerId: string): CommentDto =>
    CommentDto.parse({
      id: comment.id,
      imageId: comment.imageId,
      authorName: comment.authorName,
      body: comment.body,
      createdAt: comment.createdAt,
      canDelete: comment.ownerId === ownerId,
    });

  async function existingImage(id: number): Promise<ImageRecord> {
    const image = await store.image(id);
    if (image === undefined) throw notFound('Image');
    return image;
  }

  async function readUpload(request: Request): Promise<UploadParts> {
    if (!(request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      throw new Problem('unsupported-content-type', requestMessages.multipartRequired);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new Problem('malformed-request', requestMessages.malformed);
    }
    return splitParts(form);
  }

  async function readJson(request: Request): Promise<unknown> {
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      throw new Problem('unsupported-content-type', requestMessages.jsonRequired);
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > LIMITS.jsonBodyMaxBytes) {
      throw new Problem('payload-too-large', requestMessages.jsonBodyTooLarge);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Problem('malformed-request', requestMessages.malformed);
    }
  }

  return [
    http.get(
      '*/api/session',
      route(() => Promise.resolve(HttpResponse.json(SessionDto.parse({ csrfToken, uploadMaxBytes })))),
    ),

    http.get(
      '*/api/images',
      route(async ({ request }) => {
        const query = parseOrThrow(imagesQuery, queryOf(request), 'query');
        const [{ ownerId }, rows] = await Promise.all([store.state(), store.images()]);
        const page = pageOf(rows, query.limit, query.cursor);
        const items = await Promise.all(page.items.map((image) => imageDto(image, ownerId)));
        return HttpResponse.json(ImagePage.parse({ items, nextCursor: page.nextCursor }));
      }),
    ),

    http.get(
      '*/api/images/:id',
      route(async ({ params }) => {
        const image = await existingImage(pathId(params, 'id'));
        const { ownerId } = await store.state();
        return HttpResponse.json(await imageDto(image, ownerId));
      }),
    ),

    http.post(
      '*/api/images',
      route(async ({ request }) => {
        requireCsrf(request);
        const { fields, file } = await readUpload(request);
        if (file !== undefined && file.size > uploadMaxBytes) {
          throw new Problem('payload-too-large', uploadTooLarge(uploadMaxBytes));
        }

        // Every field issue at once, the missing file included (API.md §2 step 3).
        const parsed = CreateImageFields.safeParse(fields);
        const errors = parsed.success ? [] : toFieldErrors('body', parsed.error.issues);
        if (file === undefined) errors.push({ field: 'file', location: 'file', message: fileMessages.required });
        if (!parsed.success || file === undefined) throw validationFailed(errors);

        const bytes = await file.arrayBuffer();
        const mimeType = sniffImageType(new Uint8Array(bytes));
        if (mimeType === null) throw new Problem('unsupported-image-type');
        // One blob for decoding and display: the client's declared type is replaced by the sniffed one.
        const blob = new Blob([bytes], { type: mimeType });
        let size: ImageSize;
        try {
          size = await readImageSize(blob);
        } catch {
          throw new Problem('invalid-image', fileMessages.unreadable);
        }

        const { ownerId } = await store.state();
        const image = await store.insertImage(
          { ...parsed.data, ...size, mimeType, ownerId, url: null, createdAt: now().toISOString() },
          { bytes, type: mimeType },
        );
        uploadUrls.set(uploadKey(image), objectUrls.create(blob));
        return HttpResponse.json(await imageDto(image, ownerId), {
          status: 201,
          headers: { location: `/api/images/${String(image.id)}` },
        });
      }),
    ),

    http.delete(
      '*/api/images/:id',
      route(async ({ request, params }) => {
        requireCsrf(request);
        const image = await existingImage(pathId(params, 'id'));
        const { ownerId } = await store.state();
        if (image.ownerId !== ownerId) throw new Problem('not-owner', notOwnerMessages.image);
        await store.deleteImage(image.id);
        const key = uploadKey(image);
        const url = uploadUrls.get(key);
        if (url !== undefined) {
          objectUrls.revoke(url);
          uploadUrls.delete(key);
        }
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.get(
      '*/api/images/:imageId/comments',
      route(async ({ request, params }) => {
        const imageId = pathId(params, 'imageId');
        const query = parseOrThrow(commentsQuery, queryOf(request), 'query');
        await existingImage(imageId);
        const [{ ownerId }, rows] = await Promise.all([store.state(), store.comments(imageId)]);
        const page = pageOf(rows, query.limit, query.cursor);
        const items = page.items.map((comment) => commentDto(comment, ownerId));
        return HttpResponse.json(CommentPage.parse({ items, nextCursor: page.nextCursor }));
      }),
    ),

    http.post(
      '*/api/images/:imageId/comments',
      route(async ({ request, params }) => {
        requireCsrf(request);
        const imageId = pathId(params, 'imageId');
        const body = parseOrThrow(CreateCommentBody, await readJson(request), 'body');
        const { ownerId } = await store.state();
        // The store refuses a comment on a missing image in the insert's own transaction (the API's foreign key).
        try {
          const comment = await store.insertComment({ ...body, imageId, ownerId, createdAt: now().toISOString() });
          return HttpResponse.json(commentDto(comment, ownerId), { status: 201 });
        } catch (error) {
          if (error instanceof MissingImageError) throw notFound('Image');
          throw error;
        }
      }),
    ),

    http.delete(
      '*/api/comments/:id',
      route(async ({ request, params }) => {
        requireCsrf(request);
        const comment = await store.comment(pathId(params, 'id'));
        if (comment === undefined) throw notFound('Comment');
        const { ownerId } = await store.state();
        if (comment.ownerId !== ownerId) throw new Problem('not-owner', notOwnerMessages.comment);
        await store.deleteComment(comment.id);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    // API.md §6: any other /api route is a 404, and an unsafe one passes the CSRF check first.
    http.all(
      '*/api/*',
      route(({ request }) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') requireCsrf(request);
        throw notFound(`Route ${request.method} ${new URL(request.url).pathname}`);
      }),
    ),
  ];
}
