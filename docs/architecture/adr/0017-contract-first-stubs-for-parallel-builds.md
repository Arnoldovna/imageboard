# ADR 0017: Contract-first scaffold with module stubs, so modules build in parallel

- Status: proposed (revised after the architecture critique, round 1; test-harness defaults and working-tree rules
  amended in the consistency-pass review, ADR 0021)
- Date: 15 Nov 2026
- Covers: PLAN Etappe 2 (backend and frontend modules built in parallel)

## Context

PLAN.md builds backend modules in parallel, then frontend modules in parallel, each phase closed by the quality gate.
Parallel agents must not edit the same files, and each module must compile and test on its own while its siblings
are still empty. The first draft froze module _names_ but not the exact types between them: multer lived inside the
upload feature although the images router must run it, the storage port could not express `ETag`/`304`/`NoSuchKey`,
the module deps were unspecified and `createTestApp` had two different option shapes in two documents. A frozen
contract that is incomplete stalls the parallel phase, so this ADR now lists every cross-module type verbatim.

## Decision

The scaffold phase (BUILD-ORDER phase 1b) creates every file that more than one module needs, in its final form:

- `packages/shared/src/**` (complete contract with tests).
- `apps/api/src/db/schema/**` + `drizzle/0000_init.sql` (both tables).
- `apps/api/src/app.ts` and `container.ts` with the final wiring of all modules and limiters.
- `apps/api/src/shared/**` including the ports, the storage adapter and the multipart parser below (complete, tested).
- Module entry points with the signatures below and stub bodies.
- `apps/api/test/{global-setup,setup-database,test-db,test-app,images,fakes,http,fixtures}.ts`.
- Web: `app/**` (router, HomePage wiring, layout), `shared/**`, styles, and feature `index.ts` stubs exporting
  placeholder components with the final props/emits/exposed methods, plus `useGalleryStore` with its final public
  API (state + `prepend`/`remove` implemented; `loadFirst`/`loadMore`/`retry` stubbed).
- `e2e/a11y.ts`, `e2e/support/*`, `playwright.config.ts`, `docker-compose.e2e.yml`, `scripts/run-e2e.mjs`.

### Frozen API types (verbatim; the scaffold copies these)

`apps/api/src/shared/storage/object-storage.ts` (extends the skill template's port):

```ts
import type { Readable } from 'node:stream';

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
  // A plain field, not a constructor parameter property: `erasableSyntaxOnly` forbids those. Same public shape.
  readonly key: string;
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.key = key;
  }
}

export type GetObjectResult =
  | { status: 'ok'; body: Readable; contentType: string; contentLength: number; etag: string; lastModified: Date }
  | { status: 'not-modified'; etag: string };

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Throws ObjectNotFoundError for NoSuchKey/NotFound. `ifNoneMatch` → S3 IfNoneMatch; a 304 maps to 'not-modified'. */
  get(key: string, options?: { ifNoneMatch?: string }): Promise<GetObjectResult>;
  /** Idempotent: deleting a missing key resolves. */
  delete(key: string): Promise<void>;
  isReady(): Promise<boolean>;
}
```

`test/fakes.ts` `createFakeStorage(options?: { failPut?: boolean; failDelete?: number /* fail the first n calls */ })`
implements the same interface (ETag = quoted sha256 hex of the bytes, `lastModified` = put time) and exposes
`keys(): string[]` for assertions.

`apps/api/src/shared/http/multipart.ts` (moved out of the upload feature so the images router can run the real
parser while its tests use a fake upload port):

```ts
import type { RequestHandler } from 'express';

export interface MultipartLimits {
  maxFileBytes: number;
}
/** 415 unless multipart/form-data; then multer memoryStorage().single('file') with
 *  { fileSize: maxFileBytes, files: 1, fields: 3, fieldSize: 16 * 1024, parts: 4 }.
 *  Multer errors are forwarded unchanged; shared/http/problem.ts maps them (OVERVIEW §12). */
export function createMultipartParser(limits: MultipartLimits): RequestHandler;
```

`apps/api/src/shared/ports/image-upload.ts` (types only):

```ts
import type { ImageMimeType } from '@app/shared';

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
```

`apps/api/src/shared/session/actor.ts` (complete in the scaffold):

```ts
export interface Actor {
  ownerId: string | null;
}
export function actorOf(req: Request): Actor;
export const requireOwnerSession: RequestHandler; // 403 session-required without ownerId
/** Promotes a provisional session to the full SESSION_MAX_AGE_DAYS lifetime (ADR 0002). Call after a 201. */
export function markSessionActive(req: Request): void;
```

Module entry points (`features/*/index.ts`). `Database` is the Drizzle type from `db/client.ts`; `Logger` is pino's.
`requireJson`, `validate`, `requireOwnerSession`, `actorOf` and `markSessionActive` are imported from `shared/**`,
not injected (they hold no runtime state). Everything with runtime state or configuration is injected:

```ts
// features/upload/index.ts
export interface UploadConfig {
  maxPixels: number; // UPLOAD_MAX_PIXELS, per frame
  maxFrames: number; // UPLOAD_MAX_FRAMES
  maxEdge: number; // IMAGE_MAX_EDGE
  mediaPublicBaseUrl: string;
}
export interface UploadModuleDeps {
  storage: ObjectStorage;
  logger: Logger;
  config: UploadConfig;
  mediaLimiter: RequestHandler;
  sleep?: (ms: number) => Promise<void>; // injected in tests to skip retry backoff
}
export interface UploadModule {
  port: ImageUploadPort;
  mediaRouter: Router;
}
export function createUploadModule(deps: UploadModuleDeps): UploadModule;
/** `images/<uuid>.<ext>` → `previews/<uuid>.webp` (ADR 0018). Pure; re-exported for the seed scripts. */
export function previewKeyOf(objectKey: string): string;

// features/images/index.ts
export interface ImagesModuleDeps {
  db: Database;
  logger: Logger;
  upload: ImageUploadPort;
  parseMultipart: RequestHandler; // createMultipartParser({ maxFileBytes: UPLOAD_MAX_BYTES })
  limiters: { uploads: RequestHandler; uploadsGlobalDay: RequestHandler; deletes: RequestHandler };
  pageSize: number; // IMAGES_PAGE_SIZE
}
export interface ImagesModule {
  router: Router; // mounted at /api/images
  exists(id: number): Promise<boolean>;
  /** Admin script only (ADR 0019): delete regardless of owner, then discard the objects. */
  adminRemove(id: number): Promise<'removed' | 'not-found'>;
}
export function createImagesModule(deps: ImagesModuleDeps): ImagesModule;

// features/comments/index.ts
export interface CommentsModuleDeps {
  db: Database;
  logger: Logger;
  imageExists(id: number): Promise<boolean>;
  limiters: { comments: RequestHandler; deletes: RequestHandler };
  pageSize: number; // COMMENTS_PAGE_SIZE
}
export interface CommentsModule {
  imageCommentsRouter: Router; // mounted at /api/images/:imageId/comments (mergeParams)
  commentsRouter: Router; // mounted at /api/comments
}
export function createCommentsModule(deps: CommentsModuleDeps): CommentsModule;
```

Route-level middleware order inside the images router for `POST /`: `requireOwnerSession` → `limiters.uploads` →
`limiters.uploadsGlobalDay` → `parseMultipart` → controller (fields + file presence → `upload.ingest` → insert →
compensation → `markSessionActive` → `201`). App-level middleware (global limiter, fetch-metadata, CSRF) runs before.

`createApp(deps: AppDeps)` accepts one test seam: `overrides?: { uploadPort?: ImageUploadPort }`. When set, `app.ts`
passes it to `createImagesModule` instead of the real module's port (the media router is still the real one).

Test harness (`apps/api/test/test-app.ts`), the **only** shape used by every document:

```ts
export interface TestAppOptions {
  /** Merged over test defaults. Defaults set every RATE_LIMIT_* to '100000' so no test hits a limiter by accident;
   *  only rate-limits.int.test.ts passes small values. */
  env?: Partial<Record<EnvKey, string>>;
  storage?: ObjectStorage; // default createFakeStorage()
  upload?: ImageUploadPort; // default: the real upload module on `storage`
  databaseUrl?: string; // default: currentDatabaseUrl(), the test file's clone made by test/setup-database.ts
}
export interface TestApp {
  app: Express;
  db: Database;
  storage: ObjectStorage;
  databaseUrl: string;
  close(): Promise<void>; // closes pool + Redis; never drops a database (setup file or caller does)
}
export function createTestApp(options?: TestAppOptions): Promise<TestApp>;

// apps/api/test/test-db.ts
export function currentDatabaseUrl(): string; // throws outside a test file (setup file not run)
export function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }>; // extra clone of imageboard_template
export function createEmptyDatabase(): Promise<{ url: string; drop(): Promise<void> }>; // unmigrated, for migrations.int.test.ts
```

Every `createTestApp()` call builds its session middleware and limiter stores with a fresh prefix `test-<uuid>`
(`test-<uuid>:sess:`, `test-<uuid>:rl:<name>:`), the same way `container.ts` passes `APP_SLUG`. The composition
root's dependency object therefore takes the session middleware and the limiter store factory as inputs, as the
`express-feature-module` template does. They are not built inside `createApp`.

The images feature's `__tests__/fakes.ts` builds a fake `ImageUploadPort` (configurable to throw 415/400 or fail
`discard`), while the router under test still runs the real `createMultipartParser`, so multipart behaviour is
never re-implemented.

### Ownership and change rule

Each module builder owns only the files under its feature folder (listed in BUILD-ORDER.md) and replaces the stub
bodies **without changing the exported signatures**. A signature change requires stopping the phase and updating the
scaffold (and this ADR) first.

All units of a phase share one working tree (conventions §4). The API integration app imports every module's
`index.ts`, and web components render other features' public components, so ADR 0021 §2 adds these rules:

- A unit writes its internal files first. It switches its `index.ts` from the stub body to the real implementation
  last, after its internal files are complete and its unit tests pass; its integration tests then run through it.
  Until then the stub stays importable and behaves as the stub. The real `index.ts` never throws at import or at
  `create*Module()` time.
- Every saved file parses.
- Tests that render another feature's component stub it.
- A sibling-caused failure is reported to the orchestrator, never fixed in the sibling's files.

Cross-module behaviour that needs two finished modules (real upload through `POST /api/images`, delete removing the
objects, seed, admin script) is tested in a short sequential step at the end of the backend phase.

## Alternatives

- **Build modules sequentially**: simpler coordination, slower; PLAN asks for parallel.
- **Let each module edit `app.ts`**: guaranteed merge conflicts.
- **Keep multer in the upload feature and expose it through the port** (`port.parseMultipart`): works, but the fake
  port in the images tests would then have to import the real parser from another feature, which the boundary rules
  forbid. A stateless shared middleware is simpler.
- **Drop `ETag`/`304`** instead of extending the storage port: `immutable` caching makes revalidation rare, but HEAD,
  `Content-Length` and `NoSuchKey → 404` still need a richer port, so the extension is made once in the scaffold.

## Consequences

- The scaffold phase is larger than a bare template copy (hence split into 1a and 1b in BUILD-ORDER), but every later
  phase is conflict-free.
- Stubs must compile, lint and pass `pnpm verify` (stub routes are not mounted with behaviour, so no tests fail).
- `test/fakes.ts` and `shared/storage/object-storage.ts` are scaffold-owned; the S3 adapter's `get` mapping of 304
  and `NoSuchKey` is proven in phase 2 by agent A's `s3-storage.int.test.ts` (agent A may add tests, not change the
  port).
