import { z } from 'zod';

const MIB = 1024 * 1024;

const int = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const rateLimit = (fallback: number) => int(1, 1_000_000, fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(1, 65_535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Exact number of reverse proxies in front of the API (compose: 1 = nginx). Drives req.ip and req.protocol.
  TRUST_PROXY: int(0, 5, 0),
  // Origin accepted by the fetch-metadata guard. Unset = the request's own origin (ADR 0003).
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
  // On SIGTERM: time between failing readiness (503) and closing the listener, so a load balancer stops routing
  // first (ADR 0013). 0 locally; behind a load balancer >= probe interval x unhealthy threshold (ADR 0019).
  SHUTDOWN_DELAY_MS: int(0, 60_000, 0),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Separate Redis for rate limits in production (ADR 0002). Unset = REDIS_URL.
  RATE_LIMIT_REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),

  // Secure cookies need HTTPS end to end (or a proxy setting X-Forwarded-Proto: https + TRUST_PROXY).
  // Defaults to true in production; the local Docker stack over plain http sets it to false.
  COOKIE_SECURE: z.stringbool().optional(),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_MAX_AGE_DAYS: int(1, 400, 180),
  SESSION_PROVISIONAL_HOURS: int(1, 168, 24),
  CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),

  S3_ENDPOINT: z.url().optional(), // set for MinIO; omit for AWS
  S3_REGION: z.string().min(1).default('eu-central-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  MEDIA_PUBLIC_BASE_URL: z.string().min(1).default('/api/media'),

  // Memory buffers: capped at 20 MiB. Keep nginx API_MAX_BODY_SIZE above this value (ADR 0013).
  UPLOAD_MAX_BYTES: int(1, 20 * MIB, 5 * MIB),
  UPLOAD_MAX_PIXELS: int(1, 1_000_000_000, 40_000_000),
  UPLOAD_MAX_FRAMES: int(1, 1000, 200),
  IMAGE_MAX_EDGE: int(512, 8192, 2560),
  IMAGES_PAGE_SIZE: int(1, 50, 12),
  COMMENTS_PAGE_SIZE: int(1, 50, 20),

  RATE_LIMIT_GLOBAL: rateLimit(300),
  RATE_LIMIT_IDENTITIES: rateLimit(20),
  RATE_LIMIT_UPLOADS: rateLimit(10),
  RATE_LIMIT_UPLOADS_GLOBAL_DAY: rateLimit(200),
  RATE_LIMIT_COMMENTS: rateLimit(20),
  RATE_LIMIT_DELETES: rateLimit(30),
  RATE_LIMIT_MEDIA: rateLimit(1200),
});

export type Env = z.infer<typeof EnvSchema>;
export type EnvKey = keyof z.input<typeof EnvSchema>;

export function cookiesAreSecure(env: Pick<Env, 'COOKIE_SECURE' | 'NODE_ENV'>): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

/** `.env` files and compose interpolation produce `KEY=` for unset optional keys; treat those as missing. */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  );
}

/**
 * Parse and validate configuration once at startup. Never read `process.env` anywhere else:
 * pass the returned object (or the slice a module needs) through the composition root.
 * The error lists failing keys and the rule they break, never their values, so secrets stay out of logs.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}
