#!/usr/bin/env node
/**
 * pnpm test:e2e — Playwright against the production images in the isolated compose project `imageboard-e2e`
 * (conventions §6, ADR 0015). Never touches the dev project, its volumes or port 8080.
 *
 *   node scripts/run-e2e.mjs [--keep] [playwright args…]   up --build --wait → playwright test → down -v
 *   node scripts/run-e2e.mjs --up                          (pnpm e2e:up) start the stack, print E2E_BASE_URL
 *   node scripts/run-e2e.mjs --down                        (pnpm e2e:down) remove the stack and its volumes
 *
 * E2E_PORT is resolved once (process env, else .env, else 8181) and passed both to compose and to E2E_BASE_URL, so
 * the two can never disagree. On failure the compose logs are written to test-results/compose.log.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const PROJECT = 'imageboard-e2e';
const DEFAULT_PORT = '8181';
const ENV_FILE = resolve(ROOT, '.env');

const MODE_FLAGS = new Set(['--up', '--down', '--keep']);
const argv = process.argv.slice(2);
const mode = argv.includes('--down') ? 'down' : argv.includes('--up') ? 'up' : 'test';
const keep = argv.includes('--keep');
const playwrightArgs = argv.filter((arg) => !MODE_FLAGS.has(arg));

function log(message) {
  process.stdout.write(`run-e2e: ${message}\n`);
}

function resolvePort() {
  const fromEnvFile = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8'))['E2E_PORT'] : undefined;
  const port = process.env['E2E_PORT'] || fromEnvFile || DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error(`E2E_PORT must be a port number, got "${port}"`);
  }
  return port;
}

const port = resolvePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, E2E_PORT: port, E2E_BASE_URL: baseUrl };

const COMPOSE = [
  'compose',
  '-p',
  PROJECT,
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.e2e.yml',
  '--profile',
  'app',
];

/** @returns {number} exit status */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function down() {
  log(`removing ${PROJECT} (containers, network, volumes)`);
  return run('docker', [...COMPOSE, 'down', '-v', '--remove-orphans']);
}

function writeComposeLog() {
  const result = spawnSync('docker', [...COMPOSE, 'logs', '--no-color', '--timestamps'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  mkdirSync(resolve(ROOT, 'test-results'), { recursive: true });
  writeFileSync(resolve(ROOT, 'test-results/compose.log'), `${result.stdout}${result.stderr}`);
  log('compose logs written to test-results/compose.log');
}

function up() {
  if (!existsSync(ENV_FILE)) {
    process.stderr.write('run-e2e: .env is missing. Run `pnpm setup:env` first (it generates local secrets).\n');
    return 1;
  }
  log(`starting ${PROJECT} on ${baseUrl}`);
  const status = run('docker', [...COMPOSE, 'up', '-d', '--build', '--wait']);
  if (status !== 0) writeComposeLog();
  return status;
}

// Ctrl+C reaches the child processes directly (same process group). Ignore it here so the teardown below still runs.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => undefined);

function main() {
  if (mode === 'down') return down();

  const upStatus = up();
  if (mode === 'up') {
    if (upStatus === 0) process.stdout.write(`E2E_BASE_URL=${baseUrl}\n`);
    return upStatus;
  }

  let status = upStatus;
  if (status === 0) {
    status = run('pnpm', ['exec', 'playwright', 'test', ...playwrightArgs]);
    if (status !== 0) writeComposeLog();
  }
  if (keep) log(`--keep: ${PROJECT} keeps running on ${baseUrl}; remove it with pnpm e2e:down`);
  else if (existsSync(ENV_FILE)) down();
  return status;
}

process.exitCode = main();
