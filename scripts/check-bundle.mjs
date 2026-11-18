#!/usr/bin/env node
/**
 * Bundle isolation check for the live demo (PLAN Etappe 3b).
 *
 * Default: the production build (`apps/web/dist`, the one nginx serves) must contain no trace of the demo: no
 * `mockServiceWorker.js`, no `404.html`, and no shipped JS/HTML/CSS file with an MSW or demo marker. Source maps are not
 * scanned: they hold the original sources, whose comments name the demo, but browsers fetch them only in devtools.
 *
 * `--demo`: the demo build (`apps/web/dist-demo`) must contain what GitHub Pages needs: the worker, the SPA fallback
 * `404.html` (a copy of `index.html`) and asset URLs under the `/imageboard/` base.
 *
 * Usage: node scripts/check-bundle.mjs [--demo] [--dir <build dir>]
 * Exit code 0 when the build passes; 1 with a list of problems otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
export const DEMO_BASE = '/imageboard/';
export const WORKER_FILE = 'mockServiceWorker.js';

/** Strings that only the demo code and MSW contain (worker file name, MSW's log prefix, the IndexedDB name, banner). */
export const DEMO_MARKERS = [WORKER_FILE, '[MSW]', 'imageboard-demo', 'Daten bleiben nur in deinem Browser'];

const SHIPPED_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css']);

/** @param {string} dir @returns {string[]} every file below `dir`, as absolute paths */
function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * @param {string} dir the production build output
 * @returns {string[]} problems; empty when the build carries no demo code
 */
export function checkProductionBuild(dir) {
  if (!existsSync(join(dir, 'index.html'))) return [`${dir} has no index.html: run \`pnpm build\` first`];
  const problems = [];
  for (const file of [WORKER_FILE, '404.html']) {
    if (existsSync(join(dir, file))) problems.push(`${file} must not be part of the production build`);
  }
  for (const path of filesBelow(dir)) {
    if (!SHIPPED_EXTENSIONS.has(extname(path))) continue;
    const content = readFileSync(path, 'utf8');
    for (const marker of DEMO_MARKERS) {
      if (content.includes(marker)) problems.push(`${relative(dir, path)} contains the demo marker "${marker}"`);
    }
  }
  return problems;
}

/**
 * @param {string} dir the demo build output
 * @returns {string[]} problems; empty when the build is ready for GitHub Pages
 */
export function checkDemoBuild(dir) {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return [`${dir} has no index.html: run \`pnpm build:demo\` first`];
  const problems = [];
  if (!existsSync(join(dir, WORKER_FILE))) problems.push(`${WORKER_FILE} is missing`);
  const html = readFileSync(index, 'utf8');
  const fallback = join(dir, '404.html');
  if (!existsSync(fallback)) problems.push('404.html (SPA fallback for GitHub Pages) is missing');
  else if (readFileSync(fallback, 'utf8') !== html) problems.push('404.html differs from index.html');
  if (!html.includes(`src="${DEMO_BASE}assets/`))
    problems.push(`index.html does not load its script under ${DEMO_BASE}`);
  return problems;
}

function main() {
  const { values } = parseArgs({
    options: { demo: { type: 'boolean', default: false }, dir: { type: 'string' } },
  });
  const dir = resolve(values.dir ?? join(ROOT, 'apps/web', values.demo ? 'dist-demo' : 'dist'));
  const problems = values.demo ? checkDemoBuild(dir) : checkProductionBuild(dir);
  if (problems.length > 0) {
    console.error(
      `check-bundle: ${relative(ROOT, dir) || dir}\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(`check-bundle: ${relative(ROOT, dir)} ok (${values.demo ? 'demo build' : 'no demo code in production'})`);
}

if (import.meta.main) main();
