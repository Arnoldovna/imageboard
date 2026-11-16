import { describe, expect, it } from 'vitest';

import { cookiesAreSecure, loadEnv } from './env.js';

const SESSION_SECRET = 'session-secret-value-0123456789-abcdef';
const CSRF_SECRET = 'csrf-secret-value-0123456789-abcdefghij';
const S3_SECRET_ACCESS_KEY = 's3-secret-value-do-not-log';

const valid = {
  DATABASE_URL: 'postgres://imageboard:pw@127.0.0.1:5432/imageboard',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET,
  CSRF_SECRET,
  S3_BUCKET: 'uploads',
  S3_ACCESS_KEY_ID: 'minio-local',
  S3_SECRET_ACCESS_KEY,
};

function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(valid);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: 0,
      SHUTDOWN_DELAY_MS: 0,
      S3_REGION: 'eu-central-1',
      S3_FORCE_PATH_STYLE: false,
      MEDIA_PUBLIC_BASE_URL: '/api/media',
      SESSION_MAX_AGE_DAYS: 180,
      SESSION_PROVISIONAL_HOURS: 24,
      UPLOAD_MAX_BYTES: 5_242_880,
      UPLOAD_MAX_PIXELS: 40_000_000,
      UPLOAD_MAX_FRAMES: 200,
      IMAGE_MAX_EDGE: 2560,
      IMAGES_PAGE_SIZE: 12,
      COMMENTS_PAGE_SIZE: 20,
      RATE_LIMIT_GLOBAL: 300,
      RATE_LIMIT_IDENTITIES: 20,
      RATE_LIMIT_UPLOADS: 10,
      RATE_LIMIT_UPLOADS_GLOBAL_DAY: 200,
      RATE_LIMIT_COMMENTS: 20,
      RATE_LIMIT_DELETES: 30,
      RATE_LIMIT_MEDIA: 1200,
    });
    expect(env.APP_ORIGIN).toBeUndefined();
    expect(env.COOKIE_SECURE).toBeUndefined();
  });

  it('coerces numbers and booleans from strings', () => {
    const env = loadEnv({
      ...valid,
      PORT: '8080',
      TRUST_PROXY: '1',
      COOKIE_SECURE: 'false',
      S3_FORCE_PATH_STYLE: 'true',
    });

    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(1);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('treats empty values like missing keys (KEY= lines in .env)', () => {
    const env = loadEnv({ ...valid, APP_ORIGIN: '', RATE_LIMIT_REDIS_URL: '', S3_ENDPOINT: '', PORT: '' });

    expect(env.APP_ORIGIN).toBeUndefined();
    expect(env.RATE_LIMIT_REDIS_URL).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.PORT).toBe(3000);
  });

  it('F-45: missing required keys are named in the error', () => {
    const error = errorOf(() => loadEnv({}));

    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'SESSION_SECRET',
      'CSRF_SECRET',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]) {
      expect(error.message).toContain(key);
    }
  });

  it('F-45 / B-01: invalid values are reported by key, never by value', () => {
    const shortSecret = 'too-short-secret';
    const badDatabaseUrl = 'mysql://user:hunter2-password@db/app';
    const error = errorOf(() =>
      loadEnv({ ...valid, SESSION_SECRET: shortSecret, DATABASE_URL: badDatabaseUrl, PORT: '70000' }),
    );

    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('PORT');
    expect(error.message).not.toContain(shortSecret);
    expect(error.message).not.toContain('hunter2-password');
    expect(error.message).not.toContain(CSRF_SECRET);
    expect(error.message).not.toContain(S3_SECRET_ACCESS_KEY);
  });

  it('B-31: accepts postgres:// and postgresql:// only', () => {
    expect(loadEnv({ ...valid, DATABASE_URL: 'postgresql://u:p@h:5432/d' }).DATABASE_URL).toBe(
      'postgresql://u:p@h:5432/d',
    );
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'http://h/d' })).toThrow(/DATABASE_URL/);
  });

  it('caps UPLOAD_MAX_BYTES at 20 MiB (memory buffers)', () => {
    expect(loadEnv({ ...valid, UPLOAD_MAX_BYTES: String(20 * 1024 * 1024) }).UPLOAD_MAX_BYTES).toBe(20_971_520);
    expect(() => loadEnv({ ...valid, UPLOAD_MAX_BYTES: String(20 * 1024 * 1024 + 1) })).toThrow(/UPLOAD_MAX_BYTES/);
  });

  it('rejects unknown NODE_ENV and out-of-range TRUST_PROXY', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadEnv({ ...valid, TRUST_PROXY: '6' })).toThrow(/TRUST_PROXY/);
  });

  it('accepts a shutdown drain delay up to 60 s', () => {
    expect(loadEnv({ ...valid, SHUTDOWN_DELAY_MS: '15000' }).SHUTDOWN_DELAY_MS).toBe(15_000);
    expect(() => loadEnv({ ...valid, SHUTDOWN_DELAY_MS: '60001' })).toThrow(/SHUTDOWN_DELAY_MS/);
    expect(() => loadEnv({ ...valid, SHUTDOWN_DELAY_MS: '-1' })).toThrow(/SHUTDOWN_DELAY_MS/);
  });
});

describe('cookiesAreSecure', () => {
  it('defaults to secure cookies in production only', () => {
    expect(cookiesAreSecure({ NODE_ENV: 'production', COOKIE_SECURE: undefined })).toBe(true);
    expect(cookiesAreSecure({ NODE_ENV: 'development', COOKIE_SECURE: undefined })).toBe(false);
  });

  it('lets COOKIE_SECURE override the default', () => {
    expect(cookiesAreSecure({ NODE_ENV: 'production', COOKIE_SECURE: false })).toBe(false);
    expect(cookiesAreSecure({ NODE_ENV: 'test', COOKIE_SECURE: true })).toBe(true);
  });
});
