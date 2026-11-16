import { describe, expect, it } from 'vitest';

import { databaseUrlMismatches, isSecretKey, mergeEnv } from '../setup-env.mjs';

const EXAMPLE = [
  '# comment',
  'NODE_ENV=development',
  'SESSION_SECRET=',
  'CSRF_SECRET=',
  'S3_SECRET_ACCESS_KEY=',
  '# APP_ORIGIN=https://example.test',
  'WEB_PORT=8080',
  '',
].join('\n');

function counter() {
  let n = 0;
  return () => `generated-${String(++n)}`;
}

describe('isSecretKey', () => {
  it('matches SECRET as a word only', () => {
    expect(['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY'].every(isSecretKey)).toBe(true);
    expect(['SECRETARY', 'NODE_ENV', 'POSTGRES_PASSWORD', 'WEB_PORT'].some(isSecretKey)).toBe(false);
  });
});

describe('mergeEnv', () => {
  it('creates .env from the example and fills every empty secret', () => {
    const { content, filled, added } = mergeEnv(EXAMPLE, undefined, counter());

    expect(filled).toEqual(['SESSION_SECRET', 'CSRF_SECRET', 'S3_SECRET_ACCESS_KEY']);
    expect(added).toEqual([]);
    expect(content).toContain('SESSION_SECRET=generated-1\n');
    expect(content).toContain('S3_SECRET_ACCESS_KEY=generated-3\n');
    expect(content).toContain('# APP_ORIGIN=https://example.test\n');
  });

  it('never overwrites existing values and is idempotent', () => {
    const first = mergeEnv(EXAMPLE, undefined, counter()).content;
    const edited = first.replace('WEB_PORT=8080', 'WEB_PORT=9090');
    const second = mergeEnv(EXAMPLE, edited, counter());

    expect(second.content).toBe(edited);
    expect(second.filled).toEqual([]);
    expect(second.added).toEqual([]);
  });

  it('fills a secret that is still empty and appends keys missing from .env', () => {
    const current = 'NODE_ENV=production\nSESSION_SECRET=keep-me\nCSRF_SECRET=\n';
    const { content, filled, added } = mergeEnv(EXAMPLE, current, counter());

    expect(filled).toEqual(['CSRF_SECRET']);
    expect(added).toEqual(['S3_SECRET_ACCESS_KEY', 'WEB_PORT']);
    expect(content).toBe(
      [
        'NODE_ENV=production',
        'SESSION_SECRET=keep-me',
        'CSRF_SECRET=generated-1',
        '',
        '# Added by pnpm setup:env from .env.example',
        'S3_SECRET_ACCESS_KEY=generated-2',
        'WEB_PORT=8080',
        '',
      ].join('\n'),
    );
    expect(mergeEnv(EXAMPLE, content, counter()).content).toBe(content);
  });

  it('keeps quoted values as they are', () => {
    const current = 'SESSION_SECRET="quoted value"\nCSRF_SECRET=x\nS3_SECRET_ACCESS_KEY=y\nNODE_ENV=test\nWEB_PORT=1\n';

    expect(mergeEnv(EXAMPLE, current, counter()).content).toBe(current);
  });
});

describe('databaseUrlMismatches', () => {
  const parts = { POSTGRES_USER: 'imageboard', POSTGRES_PASSWORD: 'local-only', POSTGRES_DB: 'imageboard' };

  it('accepts a DATABASE_URL that names the same user, password and database', () => {
    expect(
      databaseUrlMismatches({ ...parts, DATABASE_URL: 'postgres://imageboard:local-only@127.0.0.1:5432/imageboard' }),
    ).toEqual([]);
  });

  it('names every POSTGRES_* key the URL contradicts, never a value', () => {
    const mismatches = databaseUrlMismatches({
      ...parts,
      POSTGRES_PASSWORD: 'changed-password',
      POSTGRES_DB: 'other',
      DATABASE_URL: 'postgres://imageboard:local-only@127.0.0.1:5432/imageboard',
    });

    expect(mismatches).toEqual(['POSTGRES_PASSWORD', 'POSTGRES_DB']);
  });

  it('compares percent-decoded URL parts', () => {
    expect(
      databaseUrlMismatches({
        ...parts,
        POSTGRES_PASSWORD: 'p@ss',
        DATABASE_URL: 'postgres://imageboard:p%40ss@h/imageboard',
      }),
    ).toEqual([]);
  });

  it('reports an unparsable DATABASE_URL and ignores a missing one', () => {
    expect(databaseUrlMismatches({ ...parts, DATABASE_URL: 'not a url' })).toEqual(['DATABASE_URL']);
    expect(databaseUrlMismatches(parts)).toEqual([]);
  });
});
