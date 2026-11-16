import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import type { Logger } from 'pino';

import { RATE_LIMIT_WINDOWS_MS } from './config/app.js';
import { cookiesAreSecure, type Env, uploadConfig } from './config/env.js';
import type { Database } from './db/client.js';
import { createCommentsModule } from './features/comments/index.js';
import { createImagesModule } from './features/images/index.js';
import { createSessionModule } from './features/session/index.js';
import { createUploadModule } from './features/upload/index.js';
import { createHealthRouter, type ReadinessCheck } from './shared/http/health.js';
import { createMultipartParser } from './shared/http/multipart.js';
import { createErrorHandler, notFoundHandler } from './shared/http/problem.js';
import { createRequestLogger } from './shared/logging/logger.js';
import type { ImageUploadPort } from './shared/ports/image-upload.js';
import { createCsrf } from './shared/security/csrf.js';
import { createFetchMetadataGuard } from './shared/security/fetch-metadata.js';
import { rateLimiter, type RateLimitStoreFactory, securityHeaders } from './shared/security/security.js';
import type { ObjectStorage } from './shared/storage/object-storage.js';

/** Everything the app needs from the outside world. `container.ts` builds it; tests pass Testcontainers and fakes. */
export interface AppDeps {
  env: Env;
  logger: Logger;
  db: Database;
  storage: ObjectStorage;
  /** express-session with the Redis store (`shared/security/session.ts`); its key prefix differs per test app. */
  session: RequestHandler;
  rateLimitStores: RateLimitStoreFactory;
  readiness: Readonly<Record<string, ReadinessCheck>>;
  isShuttingDown: () => boolean;
  /** Test seam (ADR 0017): replaces the upload port handed to the images module. The media router stays real. */
  overrides?: { uploadPort?: ImageUploadPort };
}

type LimiterName = keyof typeof RATE_LIMIT_WINDOWS_MS;

/**
 * Middleware order (OVERVIEW §4.1) and the final module wiring. Features never import each other: the images module
 * receives the upload port and the multipart parser, the comments module receives `imageExists` (ADR 0017).
 */
export function createApp(deps: AppDeps): Express {
  const { env, logger } = deps;
  const secure = cookiesAreSecure(env);

  // One instance per limiter, each with its own store prefix `<prefix>:rl:<name>:` (ADR 0013).
  const limiter = (name: LimiterName, limit: number, scope: 'ip' | 'global' = 'ip'): RequestHandler =>
    rateLimiter({ windowMs: RATE_LIMIT_WINDOWS_MS[name], limit, scope, store: deps.rateLimitStores(name) });
  const limiters = {
    global: limiter('global', env.RATE_LIMIT_GLOBAL),
    media: limiter('media', env.RATE_LIMIT_MEDIA),
    identities: limiter('identities', env.RATE_LIMIT_IDENTITIES),
    uploads: limiter('uploads', env.RATE_LIMIT_UPLOADS),
    uploadsGlobalDay: limiter('uploadsGlobalDay', env.RATE_LIMIT_UPLOADS_GLOBAL_DAY, 'global'),
    comments: limiter('comments', env.RATE_LIMIT_COMMENTS),
    // One shared instance for both DELETE routes.
    deletes: limiter('deletes', env.RATE_LIMIT_DELETES),
  };

  const csrf = createCsrf({ secret: env.CSRF_SECRET, secure });

  const upload = createUploadModule({
    storage: deps.storage,
    logger,
    config: uploadConfig(env),
    mediaLimiter: limiters.media,
  });
  const images = createImagesModule({
    db: deps.db,
    logger,
    upload: deps.overrides?.uploadPort ?? upload.port,
    parseMultipart: createMultipartParser({ maxFileBytes: env.UPLOAD_MAX_BYTES }),
    limiters: { uploads: limiters.uploads, uploadsGlobalDay: limiters.uploadsGlobalDay, deletes: limiters.deletes },
    pageSize: env.IMAGES_PAGE_SIZE,
  });
  const comments = createCommentsModule({
    db: deps.db,
    logger,
    imageExists: (id) => images.exists(id),
    limiters: { comments: limiters.comments, deletes: limiters.deletes },
    pageSize: env.COMMENTS_PAGE_SIZE,
  });
  const session = createSessionModule({
    identityLimiter: limiters.identities,
    issueCsrfToken: (req, res) => csrf.generateCsrfToken(req, res),
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');
  // Paths are case-sensitive like nginx's locations: otherwise /api/HEALTH would reach the internal health router
  // past nginx's /api/health block (ADR 0013). This setting covers the app's own router (the mount paths) and must be
  // set before the first app.use; every feature router is created with `caseSensitive: true` for the paths inside it.
  app.set('case sensitive routing', true);

  app.use(createRequestLogger(logger));
  // Internal only (nginx denies it): before helmet, sessions and limits; cached readiness (ADR 0013).
  app.use('/api/health', createHealthRouter({ checks: deps.readiness, isShuttingDown: deps.isShuttingDown }));

  // HSTS exactly when the deployment is HTTPS (the same switch as Secure cookies): the local compose stack runs
  // NODE_ENV=production over plain http and must not pin HSTS (F-42).
  app.use(securityHeaders({ hsts: secure }));
  // Media: own limiter, no session, no CSRF, no body parsing (ADR 0004).
  app.use('/api/media', upload.mediaRouter);

  // The global limiter runs before body parsing: a request is counted (and rejected when over budget) before its body
  // is read, and a malformed or oversized JSON body, which ends the chain with next(err), still uses up budget.
  app.use('/api', limiters.global);
  // Headers only, so it runs before anything reads the body or the session: a cross-site request is refused without
  // parsing its body, without a Redis read and without the rolling session cookie renewing the victim's session.
  app.use('/api', createFetchMetadataGuard({ appOrigin: env.APP_ORIGIN }));
  // 16 KB JSON only; no urlencoded parser and no CORS (same origin, ADR 0003; F-49).
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use(deps.session);
  app.use(cookieParser()); // after express-session, as csrf-csrf requires

  app.use('/api/session', session.router);
  app.use(csrf.doubleCsrfProtection);

  app.use('/api/images/:imageId/comments', comments.imageCommentsRouter);
  app.use('/api/comments', comments.commentsRouter);
  app.use('/api/images', images.router);

  app.use(notFoundHandler);
  app.use(createErrorHandler({ uploadMaxBytes: env.UPLOAD_MAX_BYTES }));
  return app;
}
