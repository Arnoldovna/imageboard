#!/usr/bin/env node
/**
 * pnpm setup:env — create or complete the local .env from .env.example (conventions §5).
 *
 * - .env missing: copy .env.example and fill every empty secret key.
 * - .env present: keep every existing line and value; fill secret keys that are still empty; append keys that exist
 *   only in .env.example (with a generated value when they are secrets). Never re-randomises a secret:
 *   a new SESSION_SECRET would void every ownership cookie, a new S3_SECRET_ACCESS_KEY would lock out the MinIO volume.
 * - Secret keys are the ones whose name contains SECRET as a word (SESSION_SECRET, CSRF_SECRET, S3_SECRET_ACCESS_KEY).
 * - Prints key names only, never values. Running it twice leaves .env byte-identical.
 *
 * Usage: node scripts/setup-env.mjs [--env-file <path>] [--example <path>]
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const SECRET_KEY = /(?:^|_)SECRET(?:_|$)/;

export function isSecretKey(key) {
  return SECRET_KEY.test(key);
}

function generateSecret() {
  return randomBytes(32).toString('base64url');
}

/** @param {string} source */
function keysInOrder(source) {
  const keys = [];
  for (const line of source.split('\n')) {
    const match = KEY_LINE.exec(line);
    if (match?.[1] !== undefined && !keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * Pure merge step, exported for tests.
 * @param {string} example contents of .env.example
 * @param {string | undefined} current contents of .env, or undefined when it does not exist
 * @param {() => string} [secret] secret generator
 * @returns {{ content: string, filled: string[], added: string[] }}
 */
export function mergeEnv(example, current, secret = generateSecret) {
  const base = current ?? example;
  const values = parseEnv(base);
  const filled = [];

  const lines = base.split('\n').map((line) => {
    const key = KEY_LINE.exec(line)?.[1];
    if (key === undefined || !isSecretKey(key) || (values[key] ?? '') !== '') return line;
    filled.push(key);
    return `${key}=${secret()}`;
  });

  const exampleValues = parseEnv(example);
  const added = keysInOrder(example).filter((key) => !(key in values));
  if (added.length > 0) {
    if (lines.at(-1) === '') lines.pop();
    lines.push('', '# Added by pnpm setup:env from .env.example');
    for (const key of added) {
      const value = exampleValues[key] ?? '';
      lines.push(`${key}=${value === '' && isSecretKey(key) ? secret() : value}`);
    }
    lines.push('');
  }

  return { content: lines.join('\n'), filled, added };
}

/**
 * Compose creates the database from POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB and builds the containers' URL from
 * them, while `pnpm dev` and db:migrate on the host use DATABASE_URL. Returns the POSTGRES_* keys that DATABASE_URL
 * contradicts (or DATABASE_URL itself when it cannot be parsed): key names only, never values.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string[]}
 */
export function databaseUrlMismatches(env) {
  const raw = env['DATABASE_URL'];
  if (!raw) return [];
  let fromUrl;
  try {
    const url = new URL(raw);
    fromUrl = {
      POSTGRES_USER: decodeURIComponent(url.username),
      POSTGRES_PASSWORD: decodeURIComponent(url.password),
      POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)),
    };
  } catch {
    return ['DATABASE_URL'];
  }
  return Object.entries(fromUrl)
    .filter(([key, value]) => env[key] !== undefined && env[key] !== value)
    .map(([key]) => key);
}

function main() {
  const { values: options } = parseArgs({
    options: { 'env-file': { type: 'string' }, example: { type: 'string' } },
  });
  const envFile = resolve(ROOT, options['env-file'] ?? '.env');
  const exampleFile = resolve(ROOT, options.example ?? '.env.example');

  const example = readFileSync(exampleFile, 'utf8');
  const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined;
  const { content, filled, added } = mergeEnv(example, current);

  if (current === undefined) {
    writeFileSync(envFile, content, { mode: 0o600 });
    process.stdout.write(`setup:env: created .env from .env.example; generated ${filled.join(', ') || 'no secrets'}\n`);
    return;
  }
  if (content === current) {
    process.stdout.write('setup:env: .env is complete, nothing changed\n');
    return;
  }
  writeFileSync(envFile, content);
  const changes = [
    filled.length > 0 ? `generated ${filled.join(', ')}` : '',
    added.length > 0 ? `added ${added.join(', ')}` : '',
  ].filter(Boolean);
  process.stdout.write(`setup:env: updated .env (${changes.join('; ')}); existing values kept\n`);
}

if (import.meta.main) main();
