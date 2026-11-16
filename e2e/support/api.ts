import { randomUUID } from 'node:crypto';

import { type APIRequestContext, type APIResponse, expect } from '@playwright/test';

import { type FixtureFile, imageFixture } from './files.ts';

/**
 * Test data through the public API (ADR 0015, BUILD-ORDER phase 5 data rules).
 *
 * Every helper takes an `APIRequestContext`:
 * - `page.request` shares the browser context's cookie jar, so what it creates belongs to the page's anonymous
 *   session (`canDelete: true` in the UI);
 * - the test's `request` fixture (or `playwright.request.newContext()`) has its own cookie jar and therefore its own
 *   session: what it creates is "foreign" for the page (`canDelete: false`).
 *
 * Each mutation first calls `GET /api/session` with the same context. That creates the identity when there is none
 * and returns a CSRF token bound to the session id (API.md §1), which is sent as `x-csrf-token`. Do not run a helper
 * on `page.request` concurrently with the page's own first load of a fresh context: two parallel first calls would
 * create two identities and the last cookie would win. Call it before `page.goto()` or after the page has loaded.
 *
 * The e2e stack is never seeded and is shared by parallel workers, so specs create their own data with unique titles
 * (`uniqueTitle`) and never assert counts.
 *
 * The response types mirror the DTOs in `packages/shared/src/{session,images,comments}.ts`. They are declared here
 * because the root package does not depend on the workspace packages; the API's own tests pin the exact key sets.
 */

/** `GET /api/session` → `SessionDto`. */
export interface SessionInfo {
  csrfToken: string;
  /** Effective `UPLOAD_MAX_BYTES` of the stack under test (F-20). */
  uploadMaxBytes: number;
}

/** `ImageDto`. */
export interface ImageInfo {
  id: number;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  mimeType: string;
  authorName: string;
  title: string;
  description: string;
  createdAt: string;
  canDelete: boolean;
}

/** `CommentDto`. */
export interface CommentInfo {
  id: number;
  imageId: number;
  authorName: string;
  body: string;
  createdAt: string;
  canDelete: boolean;
}

export interface CreateImageInput {
  /** Use `uniqueTitle()`: the stack is shared by parallel workers. */
  title: string;
  authorName?: string;
  /** Omitted from the request when undefined (the field is optional, F-18). */
  description?: string;
  /** Defaults to `imageFixture('landscapeJpeg')`. */
  file?: FixtureFile;
}

export interface CreateCommentInput {
  body: string;
  authorName?: string;
}

/**
 * Postgres `integer` maximum: the largest path id the API accepts, and one no test creates (the e2e stack starts empty
 * and stays far below it), so it names an unknown image. One above it is a 400 (F-44).
 */
export const MAX_ID = 2_147_483_647;

/** Fictional default display name for data created by e2e helpers. */
export const E2E_AUTHOR = 'E2E Tester';

/** Leaves room for the random suffix within the 120 code point title limit (F-18). UTF-16 length >= code points. */
const MAX_LABEL_LENGTH = 100;

/**
 * A title that no other test, worker or earlier run uses: `<label> <8 hex chars>`. Locate tiles and rows by this
 * exact text, never by position or count.
 */
export function uniqueTitle(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '' || trimmed.length > MAX_LABEL_LENGTH) {
    throw new RangeError(`uniqueTitle: label must have 1 to ${String(MAX_LABEL_LENGTH)} characters`);
  }
  return `${trimmed} ${randomUUID().slice(0, 8)}`;
}

/** Throws with the status line and the (problem+json) body, so a failed setup step explains itself. */
async function expectStatus(response: APIResponse, expected: number, action: string): Promise<void> {
  if (response.status() === expected) return;
  const body = await response.text().catch(() => '<unreadable body>');
  throw new Error(
    `${action}: expected HTTP ${String(expected)}, got ${String(response.status())} ${response.statusText()}\n` +
      body.slice(0, 2000),
  );
}

type FieldKind = 'string' | 'number' | 'boolean';
type Shape<T> = { readonly [K in keyof T]-?: FieldKind };

const SESSION_SHAPE: Shape<SessionInfo> = { csrfToken: 'string', uploadMaxBytes: 'number' };
const IMAGE_SHAPE: Shape<ImageInfo> = {
  id: 'number',
  url: 'string',
  previewUrl: 'string',
  width: 'number',
  height: 'number',
  mimeType: 'string',
  authorName: 'string',
  title: 'string',
  description: 'string',
  createdAt: 'string',
  canDelete: 'boolean',
};
const COMMENT_SHAPE: Shape<CommentInfo> = {
  id: 'number',
  imageId: 'number',
  authorName: 'string',
  body: 'string',
  createdAt: 'string',
  canDelete: 'boolean',
};

/** Checks the JSON body against the expected field types, so contract drift fails here and not deep in a spec. */
async function readJson<T>(response: APIResponse, shape: Shape<T>, action: string): Promise<T> {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${action}: expected a JSON object, got ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, kind] of Object.entries<FieldKind>(shape)) {
    if (typeof record[key] !== kind) {
      throw new Error(`${action}: "${key}" should be a ${kind}, got ${JSON.stringify(record[key])}`);
    }
  }
  return value as T;
}

/** `GET /api/session`: ensures an anonymous identity for this context and returns a CSRF token for it. */
export async function getSessionViaApi(request: APIRequestContext): Promise<SessionInfo> {
  const response = await request.get('/api/session');
  await expectStatus(response, 200, 'GET /api/session');
  return readJson(response, SESSION_SHAPE, 'GET /api/session');
}

async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const { csrfToken } = await getSessionViaApi(request);
  return { 'x-csrf-token': csrfToken };
}

/** `POST /api/images` (multipart): uploads a fixture as the context's session; returns the `201` body. */
export async function createImageViaApi(request: APIRequestContext, input: CreateImageInput): Promise<ImageInfo> {
  const file = input.file ?? imageFixture();
  const response = await request.post('/api/images', {
    headers: await csrfHeaders(request),
    // Text parts first, file last: the order a browser's FormData from the upload form produces.
    multipart: {
      authorName: input.authorName ?? E2E_AUTHOR,
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      file,
    },
  });
  await expectStatus(response, 201, `POST /api/images "${input.title}"`);
  return readJson(response, IMAGE_SHAPE, 'POST /api/images');
}

/**
 * Creates `count` images titled `<prefix> 01`, `<prefix> 02`, … one after another, so their order is the creation
 * order (the gallery shows newest first, F-04). Pass a `uniqueTitle()` as prefix. Returns them oldest first.
 */
export async function createImagesViaApi(
  request: APIRequestContext,
  count: number,
  prefix: string,
  input: Omit<CreateImageInput, 'title'> = {},
): Promise<ImageInfo[]> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`createImagesViaApi: count must be a positive integer, got ${String(count)}`);
  }
  const width = String(count).length;
  const images: ImageInfo[] = [];
  for (let index = 1; index <= count; index += 1) {
    // Sequential on purpose: parallel uploads would make the creation order, and with it the gallery order, random.
    images.push(
      await createImageViaApi(request, { ...input, title: `${prefix} ${String(index).padStart(width, '0')}` }),
    );
  }
  return images;
}

/** `GET /api/images/:id` as this context sees it (`canDelete` depends on the session); `null` on `404`. */
export async function getImageViaApi(request: APIRequestContext, id: number): Promise<ImageInfo | null> {
  const response = await request.get(`/api/images/${String(id)}`);
  if (response.status() === 404) return null;
  await expectStatus(response, 200, `GET /api/images/${String(id)}`);
  return readJson(response, IMAGE_SHAPE, `GET /api/images/${String(id)}`);
}

/** `DELETE /api/images/:id` as the context's session (owner only, F-35). */
export async function deleteImageViaApi(request: APIRequestContext, id: number): Promise<void> {
  const response = await request.delete(`/api/images/${String(id)}`, { headers: await csrfHeaders(request) });
  await expectStatus(response, 204, `DELETE /api/images/${String(id)}`);
}

/** `POST /api/images/:imageId/comments` (JSON): comments as the context's session; returns the `201` body. */
export async function createCommentViaApi(
  request: APIRequestContext,
  imageId: number,
  input: CreateCommentInput,
): Promise<CommentInfo> {
  const path = `/api/images/${String(imageId)}/comments`;
  const response = await request.post(path, {
    headers: await csrfHeaders(request),
    data: { authorName: input.authorName ?? E2E_AUTHOR, body: input.body },
  });
  await expectStatus(response, 201, `POST ${path}`);
  return readJson(response, COMMENT_SHAPE, `POST ${path}`);
}

/** `DELETE /api/comments/:id` as the context's session (owner only). */
export async function deleteCommentViaApi(request: APIRequestContext, id: number): Promise<void> {
  const response = await request.delete(`/api/comments/${String(id)}`, { headers: await csrfHeaders(request) });
  await expectStatus(response, 204, `DELETE /api/comments/${String(id)}`);
}

/** One field error of a `400 validation-failed` problem (API.md §2). */
export interface FieldErrorBody {
  field: string;
  location: string;
  message: string;
}

/** An RFC 9457 problem body as the API sends it (API.md §2). */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: FieldErrorBody[];
}

/** Asserts an `application/problem+json` response with this status and code; returns the body for further checks. */
export async function expectProblem(response: APIResponse, status: number, code: string): Promise<ProblemBody> {
  expect(response.status(), await response.text()).toBe(status);
  expect(response.headers()['content-type']).toMatch(/^application\/problem\+json/);
  const problem = (await response.json()) as ProblemBody;
  expect(problem).toMatchObject({ status, code });
  expect(typeof problem.title).toBe('string');
  expect(typeof problem.detail).toBe('string');
  return problem;
}
