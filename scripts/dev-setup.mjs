#!/usr/bin/env node
/**
 * pnpm dev:setup — one command from a fresh clone to a ready dev environment (conventions §5, F-64):
 *   check tools (Node major from .nvmrc, Docker running, Compose >= 2.24.4)
 *   → setup:env (create/merge .env, never overwrite) → check DATABASE_URL against POSTGRES_*
 *   → infra:up (services up --wait, then the bucket one-shot) → db:migrate → db:seed
 * Every step is idempotent: a second run changes nothing.
 *
 * pnpm demo (`--demo`): the same, then the production images on the dev compose project (stack:up), and prints
 * the URL. The reviewer path after `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { databaseUrlMismatches } from './setup-env.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MIN_COMPOSE = [2, 24, 4]; // `!reset` / `!override` in docker-compose.e2e.yml

const demo = process.argv.includes('--demo');

function fail(message) {
  process.stderr.write(`dev:setup: ${message}\n`);
  process.exit(1);
}

/** Runs a command with inherited stdio; exits with its status on failure. */
function run(command, args) {
  process.stdout.write(`\n> ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) fail(`could not start ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function checkTools() {
  const wanted = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
  const major = process.versions.node.split('.')[0];
  if (major !== wanted) {
    fail(`Node ${wanted} is required (.nvmrc), this is ${process.version}. Switch Node versions, then retry.`);
  }
  if (output('docker', ['info', '--format', '{{.ServerVersion}}']) === undefined) {
    fail('Docker is not running. Start Docker Desktop (or the Docker daemon), then retry.');
  }
  const compose = output('docker', ['compose', 'version', '--short']);
  if (compose === undefined || !versionAtLeast(compose, MIN_COMPOSE)) {
    fail(`Docker Compose >= ${MIN_COMPOSE.join('.')} is required (found ${compose ?? 'none'}).`);
  }
}

/** @param {string} version e.g. "5.6.1" or "v2.24.4-desktop.1" @param {number[]} min */
function versionAtLeast(version, min) {
  const parts = version.replace(/^v/, '').split(/[.-]/).map(Number);
  for (const [i, wanted] of min.entries()) {
    const part = parts[i] ?? 0;
    if (Number.isNaN(part)) return false;
    if (part !== wanted) return part > wanted;
  }
  return true;
}

/** Compose and the host tools read the same .env; the process environment wins in both, so it wins here too. */
function readEnv() {
  return { ...parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')), ...process.env };
}

function checkDatabaseUrl() {
  const mismatches = databaseUrlMismatches(readEnv());
  if (mismatches.length > 0) {
    fail(
      `DATABASE_URL disagrees with ${mismatches.join(', ')} in .env. Compose creates the database from POSTGRES_*, ` +
        'while pnpm dev and db:migrate connect with DATABASE_URL: make them name the same user, password and database.',
    );
  }
}

checkTools();
run(process.execPath, [resolve(ROOT, 'scripts/setup-env.mjs')]);
checkDatabaseUrl();
run('pnpm', ['infra:up']);
run('pnpm', ['db:migrate']);
run('pnpm', ['db:seed']);

if (demo) {
  run('docker', ['compose', '--profile', 'app', 'up', '-d', '--build', '--wait']);
  // Same precedence as Compose: process environment, then .env, then the compose default.
  const port = readEnv()['WEB_PORT'] || '8080';
  process.stdout.write(`\nImageboard is running at http://127.0.0.1:${port}\nStop it with: pnpm stack:down\n`);
} else {
  process.stdout.write('\ndev:setup: done. Start the apps with: pnpm dev\n');
}
