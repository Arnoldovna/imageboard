import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkTraceability,
  extractDefinedIds,
  extractTestTitles,
  findTestFiles,
  idsIn,
  validateAllowList,
} from '../check-traceability.mjs';

describe('extractDefinedIds', () => {
  it('reads bold criterion definitions and bug headings, not references in prose or tables', () => {
    const markdown = [
      '# Features',
      '- **F-D1** (new) [A]: migrations only.',
      '- **F-01** (legacy) [A][E]: newest first. Closes B-46.',
      '| R-03 | F-57 | sticky bar |',
      '### B-02 · Critical · Anyone can delete any image',
      '- **Fix:** → F-34, F-35',
      '- **F-01** repeated definitions are listed once',
    ].join('\n');

    expect(extractDefinedIds(markdown)).toEqual(['F-D1', 'F-01', 'B-02']);
  });
});

describe('idsIn', () => {
  it('finds ids separated by punctuation and ignores look-alikes', () => {
    expect(idsIn('F-03/F-55: tile (B-68, F-D2) and B-07:')).toEqual(['F-03', 'F-55', 'B-68', 'F-D2', 'B-07']);
    expect(idsIn('XF-01, F-012x, F-01-a, ab-F-02')).toEqual([]);
  });
});

describe('extractTestTitles', () => {
  it('reads Vitest and Playwright titles, including .each tables, template literals and steps', () => {
    const source = [
      "describe('F-34: sessions', () => {",
      "  it('B-07: rejects (a) thing', () => {});",
      '  it.each([["a", (x) => x(1)], ["b", 2]])("F-18: %s rejects", () => {});',
      '  test.describe.serial(`F-04: pages ${String(1 + 2)} of {n}`, () => { test("F-05: runs", async () => {}); });',
      "  test('F-28: posts', async () => { await test.step('F-26: shows the body', async () => {}); });",
      "  it.concurrent('F-27: order', () => {});",
      '});',
    ].join('\n');

    expect(extractTestTitles(source)).toEqual([
      { title: 'F-34: sessions', skipped: false, line: 1 },
      { title: 'B-07: rejects (a) thing', skipped: false, line: 2 },
      { title: 'F-18: %s rejects', skipped: false, line: 3 },
      { title: 'F-04: pages ${String(1 + 2)} of {n}', skipped: false, line: 4 },
      { title: 'F-05: runs', skipped: false, line: 4 },
      { title: 'F-28: posts', skipped: false, line: 5 },
      { title: 'F-26: shows the body', skipped: false, line: 5 },
      { title: 'F-27: order', skipped: false, line: 6 },
    ]);
  });

  it('marks skipped, conditional and placeholder tests, which never prove anything', () => {
    const source = [
      "it.skip('F-01: a', () => {});",
      "it.skipIf(process.env.CI)('F-02: b', () => {});",
      "it.todo('F-03: c');",
      "test.fixme('F-04: d', async () => {});",
      "test.describe.skip('F-05: e', () => { test('F-06: inside a skipped describe', async () => {}); });",
      "it.runIf(process.env.CI)('F-07: f', () => {});",
      "describe('F-08: runs', () => { it('F-09: runs too', () => {}); });",
    ].join('\n');

    expect(extractTestTitles(source).map(({ title, skipped }) => [title.slice(0, 4), skipped])).toEqual([
      ['F-01', true],
      ['F-02', true],
      ['F-03', true],
      ['F-04', true],
      ['F-05', true],
      ['F-06', true],
      ['F-07', true],
      ['F-08', false],
      ['F-09', false],
    ]);
  });

  it('never counts expected failures, runtime skips or a describe in which no test runs', () => {
    const source = [
      "it.fails('F-01: passes only while broken', () => {});",
      "test.fail('F-02: expected to fail', async () => {});",
      "test('F-03: skipped in its body', async () => { test.skip(true); });",
      "test('F-04: fixme in a step', async () => { await test.step('F-05: step', async () => { test.fixme(); }); });",
      "test.describe('F-06: skipped by condition', () => {",
      "  test.skip(({ browserName }) => browserName === 'webkit', 'Chromium only');",
      "  test('F-07: inside', async () => {});",
      '});',
      "describe('F-08: only placeholders', () => { it.todo('F-09: later'); });",
      "describe('F-10: one runs', () => { it.skip('F-11: off', () => {}); it(titleFor('x'), () => {}); });",
      "test.describe(() => { test('F-12: inside an anonymous describe', async () => {}); });",
    ].join('\n');

    expect(extractTestTitles(source).map(({ title, skipped }) => [title.slice(0, 4), skipped])).toEqual([
      ['F-01', true],
      ['F-02', true],
      ['F-03', true],
      ['F-04', true],
      ['F-05', true],
      ['F-06', true],
      ['F-07', true],
      ['F-08', true],
      ['F-09', true],
      ['F-10', false],
      ['F-11', true],
      ['F-12', false],
    ]);
  });

  it('applies a runtime skip at file level to every test of the file', () => {
    const source = ["test.skip(isMobile, 'desktop only');", "test('F-01: a', async () => {});"].join('\n');

    expect(extractTestTitles(source)).toEqual([{ title: 'F-01: a', skipped: true, line: 2 }]);
  });

  it('ignores other calls, titles that are not literals, and test code inside strings or comments', () => {
    const source = [
      "submit('F-01: not a test');",
      "page.test('F-02: a method of another object');",
      "test.skip(isMobile, 'F-03: a runtime skip reason, not a title');",
      'it(titleFor("F-04"), () => {});',
      "const it2 = 'F-05'; // it('F-06: a title in a comment', () => {});",
      'const fixture = "it(\'F-07: a title inside a string fixture\', () => {})";',
      "/* test('F-08: a title in a block comment', () => {}); */",
    ].join('\n');

    expect(extractTestTitles(source)).toEqual([]);
  });
});

describe('validateAllowList', () => {
  const defined = new Set(['F-61', 'B-77', 'B-78']);
  const files = new Map([['stylelint.config.mjs', "'selector-max-id': 0"]]);
  const read = (/** @type {string} */ file) => files.get(file);

  it('accepts an entry with a proof and evidence that exists and contains the named text', () => {
    const allow = {
      items: [
        {
          id: 'B-77',
          proof: 'stylelint',
          evidence: [{ file: 'stylelint.config.mjs', contains: "'selector-max-id': 0" }],
        },
      ],
    };

    const { entries, problems } = validateAllowList(allow, defined, read);

    expect(problems).toEqual([]);
    expect([...entries.keys()]).toEqual(['B-77']);
  });

  it('reports unknown and duplicate ids, missing proofs and evidence that does not hold', () => {
    const allow = {
      items: [
        { id: 'B-99', proof: 'lint', evidence: [{ file: 'stylelint.config.mjs' }] },
        { id: 'B-77', proof: ' ', evidence: [{ file: 'stylelint.config.mjs' }] },
        { id: 'B-77', proof: 'stylelint', evidence: [{ file: 'stylelint.config.mjs' }] },
        { id: 'B-78', proof: 'stylelint', evidence: [] },
        { id: 'F-61', proof: 'stylelint', evidence: [{ file: 'missing.mjs' }] },
        { id: 'F-61x', proof: 'x', evidence: [{ file: 'stylelint.config.mjs', contains: 'selector-max-type' }] },
        { proof: 'no id' },
      ],
    };

    const { problems } = validateAllowList(allow, defined, read);

    expect(problems).toEqual([
      'allow-file items[0]: B-99 is not defined in docs/FEATURES.md or docs/BUGS.md',
      'allow-file items[1]: B-77 names no proof',
      'allow-file items[2]: B-77 is listed twice',
      'allow-file items[3]: B-78 has no evidence file',
      'allow-file items[4]: F-61 evidence file "missing.mjs" does not exist',
      'allow-file items[5]: F-61x is not defined in docs/FEATURES.md or docs/BUGS.md',
      'allow-file items[5]: F-61x evidence "stylelint.config.mjs" does not contain "selector-max-type"',
      'allow-file items[6]: "id" is missing',
    ]);
  });

  it('rejects a file without an items array', () => {
    expect(validateAllowList([], defined, read).problems).toEqual([
      'allow-file: expected an object with an "items" array',
    ]);
  });
});

describe('checkTraceability (on a fixture repository)', () => {
  /** @type {string[]} */
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** @param {Record<string, string>} files */
  function repo(files) {
    const root = mkdtempSync(join(tmpdir(), 'traceability-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const docs = {
    'docs/FEATURES.md': '- **F-01** (legacy): newest first.\n- **F-61** (new): styling.\n- **F-62** (legacy): none.\n',
    'docs/BUGS.md': '### B-01 · Critical · secrets\n### B-02 · Critical · delete\n',
    'stylelint.config.mjs': "'selector-max-id': 0\n",
  };
  const allow = JSON.stringify({
    items: [
      { id: 'F-61', proof: 'stylelint', evidence: [{ file: 'stylelint.config.mjs', contains: 'selector-max-id' }] },
    ],
  });

  it('lists every id without a running test or a static proof', () => {
    const root = repo({
      ...docs,
      'scripts/traceability-allow.json': allow,
      'apps/api/src/__tests__/a.test.ts': "it('F-01, B-01: covered', () => {});\nit.skip('B-02: skipped', () => {});\n",
      'e2e/b.spec.ts': "test('B-99: unknown id', async () => {});\n",
      'apps/api/node_modules/dep/c.test.ts': "it('F-62: dependency tests never count', () => {});\n",
      'apps/api/dist/d.test.js': "it('F-62: build output never counts', () => {});\n",
    });

    const result = checkTraceability({ root });

    expect(result.missing).toEqual(['F-62', 'B-02']);
    expect(result.problems).toEqual([]);
    expect(result.tested.get('F-01')).toEqual(['apps/api/src/__tests__/a.test.ts:1']);
    expect([...result.allowed.keys()]).toEqual(['F-61']);
    expect(result.unknownInTests).toEqual(['B-99']);
    expect(result.skippedRefs).toEqual(['B-02 in a skipped test at apps/api/src/__tests__/a.test.ts:2']);
  });

  it('reports a missing allow-file as a problem', () => {
    const root = repo({ ...docs, 'e2e/a.spec.ts': "test('F-01 F-61 F-62 B-01 B-02', async () => {});\n" });

    const result = checkTraceability({ root });

    expect(result.missing).toEqual([]);
    expect(result.problems).toEqual(['allow-file scripts/traceability-allow.json does not exist']);
  });

  it('finds test and spec files only, outside dependency and output folders', () => {
    const root = repo({
      'a.test.ts': '',
      'b.spec.ts': '',
      'c.int.test.ts': '',
      'scripts/__tests__/d.test.mjs': '',
      'e.ts': '',
      'node_modules/f.test.ts': '',
      'test-results/g.spec.ts': '',
    });

    expect(findTestFiles(root)).toEqual(['a.test.ts', 'b.spec.ts', 'c.int.test.ts', 'scripts/__tests__/d.test.mjs']);
  });
});

describe('the repository', () => {
  it('traces every F-xx and B-xx to a test title or a checked static proof', () => {
    const result = checkTraceability();

    expect(result.problems).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.unknownInTests).toEqual([]);
  });
});
