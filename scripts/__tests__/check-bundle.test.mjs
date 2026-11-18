import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkDemoBuild, checkProductionBuild, DEMO_MARKERS, WORKER_FILE } from '../check-bundle.mjs';

const dirs = [];

/** @param {Record<string, string>} files */
function buildDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-bundle-'));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INDEX = '<script type="module" src="/imageboard/assets/index-abc.js"></script>';

describe('checkProductionBuild', () => {
  it('accepts a build without demo code; source maps may name the demo', () => {
    const dir = buildDir({
      'index.html': '<script type="module" src="/assets/index-abc.js"></script>',
      'assets/index-abc.js': 'console.log("gallery")',
      'assets/index-abc.js.map': '{"sourcesContent":["await import(\'./demo/index\') // imageboard-demo"]}',
    });

    expect(checkProductionBuild(dir)).toEqual([]);
  });

  it.each(DEMO_MARKERS)('rejects shipped code that contains the demo marker %s', (marker) => {
    const dir = buildDir({ 'index.html': '', 'assets/demo-x.js': `const x = ${JSON.stringify(marker)};` });

    expect(checkProductionBuild(dir)).toEqual([`assets/demo-x.js contains the demo marker "${marker}"`]);
  });

  it('rejects the worker script and the Pages fallback, and a missing build', () => {
    const dir = buildDir({ 'index.html': '', [WORKER_FILE]: '', '404.html': '' });

    expect(checkProductionBuild(dir)).toEqual([
      `${WORKER_FILE} must not be part of the production build`,
      '404.html must not be part of the production build',
    ]);
    expect(checkProductionBuild(join(dir, 'missing'))[0]).toMatch(/has no index.html/);
  });
});

describe('checkDemoBuild', () => {
  it('accepts a demo build with worker, identical 404.html and the /imageboard/ base', () => {
    const dir = buildDir({ 'index.html': INDEX, '404.html': INDEX, [WORKER_FILE]: '' });

    expect(checkDemoBuild(dir)).toEqual([]);
  });

  it('lists every missing piece', () => {
    const dir = buildDir({ 'index.html': '<script src="/assets/index.js"></script>', '404.html': 'other' });

    expect(checkDemoBuild(dir)).toEqual([
      `${WORKER_FILE} is missing`,
      '404.html differs from index.html',
      'index.html does not load its script under /imageboard/',
    ]);
  });
});
