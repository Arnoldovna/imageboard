#!/usr/bin/env node
/**
 * Traceability check (BUILD-ORDER phase 5.2, OVERVIEW §15/§17).
 *
 * Every acceptance criterion `F-xx` in docs/FEATURES.md and every legacy bug `B-xx` in docs/BUGS.md must be named in
 * the title of at least one test (Vitest `it`/`test`/`describe`, Playwright `test`/`test.describe`/`test.step`, incl.
 * `.each`), or be listed in the allow-file with a static proof (lint, stylelint, utility check, typecheck, CI job,
 * docs) whose evidence the script checks: each named file must exist and contain the named text, so a proof cannot
 * rot silently.
 *
 * Titles of tests that prove nothing never count: conditional, skipped, placeholder and expected-to-fail tests
 * (`.skip`, `.skipIf`, `.runIf`, `.todo`, `.fixme`, `.fail`, `.fails`), tests skipped at runtime (`test.skip()`,
 * `test.skip(condition)`, `test.fixme()`, `test.fail()` in their body, in an enclosing `describe` or at file level),
 * anything inside such a `describe`, and a `describe` without a single running test. Whether the matched tests pass
 * is proven by `pnpm verify`; this script proves that each id has one.
 *
 * Usage: node scripts/check-traceability.mjs [--root <dir>] [--allow <file>] [--verbose]
 * Exit code 0 when every id is covered; 1 otherwise (missing ids or an invalid allow-file are listed).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';

const DEFAULT_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_ALLOW = 'scripts/traceability-allow.json';

/** Directories that never hold source tests (build output, reports, dependencies). */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
]);
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/;
/** Test-defining callees; titles of these (and of their modifier chains) are test titles. */
const TEST_CALLEES = new Set(['it', 'test', 'describe', 'suite']);
/**
 * Modifiers whose title proves nothing because the test does not run, runs only under a condition, or passes only
 * while it fails (Vitest `it.fails`, Playwright `test.fail`). Playwright's `test.step('...')` does count: a step runs
 * inside its test, and a failing step fails the test.
 */
const NON_PROVING_MODIFIERS = new Set(['skip', 'skipIf', 'runIf', 'todo', 'fixme', 'fail', 'fails']);
/** Modifiers of a test declaration whose title is not a literal (`it(titleFor(x), fn)`); anything else is a hook. */
const DECLARATION_MODIFIERS = new Set(['only', 'concurrent', 'sequential', 'serial', 'parallel', 'each', 'for']);
const SUITE_CALLEES = new Set(['describe', 'suite']);

/**
 * Ids defined in a requirements document: a bold `**F-xx**` definition (FEATURES) or a `### B-xx` heading (BUGS).
 * Mentions in prose or tables are references, not definitions.
 * @param {string} markdown
 * @returns {string[]} ids in document order, without duplicates
 */
export function extractDefinedIds(markdown) {
  const ids = [];
  const definition = /(?:^- \*\*|^#{2,4} )((?:F|B)-[A-Z]?\d+)\b/gm;
  for (const match of markdown.matchAll(definition)) {
    const id = match[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * All requirement ids mentioned in a text (for example a test title). "F-03/F-55", "(F-01, B-46)" and "B-07:" match;
 * "XF-01" and "F-012" do not.
 * @param {string} text
 * @returns {string[]}
 */
export function idsIn(text) {
  return [...text.matchAll(/(?<![\w-])((?:F|B)-[A-Z]?\d+)(?![\w-])/g)].map((match) => match[1] ?? '');
}

/**
 * The callee chain of a call, root first: `it.each(table)` -> ['it', 'each'], `test.describe.serial` ->
 * ['test', 'describe', 'serial']. A call inside the chain (`.each(table)`, `.skipIf(cond)`) is looked through.
 * Undefined for anything that is not a plain identifier chain.
 * @param {ts.Expression} expression
 * @returns {string[] | undefined}
 */
function calleeChain(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const head = calleeChain(expression.expression);
    return head === undefined ? undefined : [...head, expression.name.text];
  }
  if (ts.isCallExpression(expression)) return calleeChain(expression.expression);
  return undefined;
}

/**
 * The literal text of a title argument, or undefined when it is computed.
 * @param {ts.Expression} node
 * @param {ts.SourceFile} file
 * @returns {string | undefined}
 */
function literalTitle(node, file) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(file).slice(1, -1);
  return undefined;
}

/**
 * @typedef {{ kind: 'suite' | 'test' | 'step', title: string | undefined, line: number, parent: TestEntry | undefined,
 *   flagged: boolean }} TestEntry
 */

/**
 * Test titles in a test file's source: the literal first argument of `it(...)`, `test(...)`, `describe(...)` and
 * their modifier chains (`it.each([...])('...')`, `test.describe.serial('...')`, `test.step('...')`). The source is
 * parsed with the TypeScript compiler, so text inside strings, comments or fixtures never counts as a test.
 * `skipped` is true when the title proves nothing: the chain, or the chain of an enclosing `describe`, contains a
 * non-proving modifier; a runtime `test.skip()`/`test.fixme()`/`test.fail()` applies to the test, to the `describe`
 * or to the file it is called in; or the title belongs to a `describe` in which no test runs.
 * @param {string} source
 * @param {string} [fileName] decides the parser (TS or JS); defaults to TS
 * @returns {{ title: string, skipped: boolean, line: number }[]}
 */
export function extractTestTitles(source, fileName = 'test.ts') {
  const kind = /\.[cm]?js$/.test(fileName)
    ? ts.ScriptKind.JS
    : fileName.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  /** @type {TestEntry[]} */
  const entries = [];
  let fileFlagged = false;

  /**
   * @param {ts.Node} node
   * @param {TestEntry | undefined} parent the innermost enclosing test call
   */
  const visit = (node, parent) => {
    const entry = ts.isCallExpression(node) ? visitCall(node, parent) : undefined;
    ts.forEachChild(node, (child) => {
      visit(child, entry ?? parent);
    });
  };

  /**
   * Records a test, step or describe call, or applies a runtime skip annotation to what encloses it.
   * @param {ts.CallExpression} call
   * @param {TestEntry | undefined} parent
   * @returns {TestEntry | undefined} the new entry, which encloses the call's callback
   */
  const visitCall = (call, parent) => {
    // `it.each(table)` and `it.skipIf(cond)` are looked through by the call that uses them as its callee.
    if (ts.isCallExpression(call.parent) && call.parent.expression === call) return undefined;
    const chain = calleeChain(call.expression);
    if (chain === undefined || !TEST_CALLEES.has(chain[0] ?? '')) return undefined;

    const modifiers = chain.slice(1);
    const nonProving = modifiers.some((modifier) => NON_PROVING_MODIFIERS.has(modifier));
    const [first] = call.arguments;
    const title = first === undefined ? undefined : literalTitle(first, file);
    // A computed title (`it(titleFor(x), fn)`) or an anonymous `test.describe(fn)` still declares a test or suite.
    const declaresUntitled =
      !nonProving &&
      modifiers.every((modifier) => DECLARATION_MODIFIERS.has(modifier) || SUITE_CALLEES.has(modifier)) &&
      call.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));

    if (title === undefined && !declaresUntitled) {
      if (nonProving) {
        // A runtime annotation (Playwright `test.skip()`, `test.skip(condition, reason)`, `test.fixme()`,
        // `test.fail()`): it applies to the enclosing test (a step belongs to its test), to every test of the
        // enclosing describe, or to the whole file.
        let target = parent;
        while (target?.kind === 'step') target = target.parent;
        if (target === undefined) fileFlagged = true;
        else target.flagged = true;
      }
      return undefined;
    }

    /** @type {TestEntry} */
    const entry = {
      kind: chain.some((name) => SUITE_CALLEES.has(name)) ? 'suite' : modifiers.includes('step') ? 'step' : 'test',
      title,
      line: file.getLineAndCharacterOfPosition((first ?? call).getStart(file)).line + 1,
      parent,
      flagged: nonProving,
    };
    entries.push(entry);
    return entry;
  };
  visit(file, undefined);

  /** @param {TestEntry} entry */
  const flagged = (entry) => {
    for (let current = entry; current !== undefined; current = current.parent) if (current.flagged) return true;
    return fileFlagged;
  };
  /** @type {Set<TestEntry>} suites that contain at least one running test */
  const running = new Set();
  for (const entry of entries) {
    if (entry.kind !== 'test' || flagged(entry)) continue;
    for (let current = entry.parent; current !== undefined; current = current.parent) running.add(current);
  }

  return entries.flatMap((entry) =>
    entry.title === undefined
      ? []
      : [
          {
            title: entry.title,
            skipped: flagged(entry) || (entry.kind === 'suite' && !running.has(entry)),
            line: entry.line,
          },
        ],
  );
}

/**
 * Test files below `root`, relative paths with forward slashes, sorted.
 * @param {string} root
 * @returns {string[]}
 */
export function findTestFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(relative(root, join(dir, entry.name)).split('\\').join('/'));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * @typedef {{ file: string, contains?: string }} Evidence
 * @typedef {{ id: string, proof: string, evidence: Evidence[] }} AllowEntry
 */

/**
 * Validates the allow-file against the defined ids and the repository. Each entry needs a known id, a non-empty
 * `proof` and at least one `evidence` file that exists (and contains `contains`, when given).
 * @param {unknown} allow parsed allow-file
 * @param {ReadonlySet<string>} definedIds
 * @param {(file: string) => string | undefined} readRepoFile returns the file content, or undefined if missing
 * @returns {{ entries: Map<string, AllowEntry>, problems: string[] }}
 */
export function validateAllowList(allow, definedIds, readRepoFile) {
  /** @type {Map<string, AllowEntry>} */
  const entries = new Map();
  const problems = [];
  const items = typeof allow === 'object' && allow !== null && 'items' in allow ? allow.items : undefined;
  if (!Array.isArray(items)) return { entries, problems: ['allow-file: expected an object with an "items" array'] };

  for (const [index, item] of items.entries()) {
    const where = `allow-file items[${String(index)}]`;
    const id = typeof item?.id === 'string' ? item.id : undefined;
    if (id === undefined) {
      problems.push(`${where}: "id" is missing`);
      continue;
    }
    if (!definedIds.has(id)) problems.push(`${where}: ${id} is not defined in docs/FEATURES.md or docs/BUGS.md`);
    if (entries.has(id)) problems.push(`${where}: ${id} is listed twice`);
    if (typeof item.proof !== 'string' || item.proof.trim() === '') problems.push(`${where}: ${id} names no proof`);
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (evidence.length === 0) problems.push(`${where}: ${id} has no evidence file`);
    for (const ref of evidence) {
      const file = typeof ref?.file === 'string' ? ref.file : '';
      const content = file === '' ? undefined : readRepoFile(file);
      if (content === undefined) {
        problems.push(`${where}: ${id} evidence file "${file}" does not exist`);
      } else if (typeof ref.contains === 'string' && !content.includes(ref.contains)) {
        problems.push(`${where}: ${id} evidence "${file}" does not contain "${ref.contains}"`);
      }
    }
    entries.set(id, { id, proof: String(item.proof ?? ''), evidence });
  }
  return { entries, problems };
}

/**
 * Runs the whole check.
 * @param {{ root?: string, allowFile?: string }} [options]
 */
export function checkTraceability({ root = DEFAULT_ROOT, allowFile = DEFAULT_ALLOW } = {}) {
  const read = (/** @type {string} */ file) => readFileSync(join(root, file), 'utf8');
  /** @param {string} file */
  const readIfExists = (file) => (existsSync(join(root, file)) ? read(file) : undefined);
  const definedIds = [...extractDefinedIds(read('docs/FEATURES.md')), ...extractDefinedIds(read('docs/BUGS.md'))];
  const defined = new Set(definedIds);

  /** @type {Map<string, string[]>} id -> "file:line" of proving tests */
  const tested = new Map();
  /** @type {string[]} */
  const skippedRefs = [];
  for (const file of findTestFiles(root)) {
    for (const { title, skipped, line } of extractTestTitles(read(file), file)) {
      for (const id of idsIn(title)) {
        if (skipped) {
          skippedRefs.push(`${id} in a skipped test at ${file}:${String(line)}`);
          continue;
        }
        const refs = tested.get(id) ?? [];
        refs.push(`${file}:${String(line)}`);
        tested.set(id, refs);
      }
    }
  }

  const allowSource = readIfExists(allowFile);
  const { entries, problems } =
    allowSource === undefined
      ? { entries: new Map(), problems: [`allow-file ${allowFile} does not exist`] }
      : validateAllowList(JSON.parse(allowSource), defined, readIfExists);

  const unknownInTests = [...tested.keys()].filter((id) => !defined.has(id)).sort();
  const missing = definedIds.filter((id) => !tested.has(id) && !entries.has(id));
  return { definedIds, tested, allowed: entries, missing, problems, unknownInTests, skippedRefs };
}

function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: DEFAULT_ROOT },
      allow: { type: 'string', default: DEFAULT_ALLOW },
      verbose: { type: 'boolean', default: false },
    },
  });
  const result = checkTraceability({ root: resolve(values.root), allowFile: values.allow });
  const byTest = result.definedIds.filter((id) => result.tested.has(id)).length;
  const byProof = result.definedIds.filter((id) => !result.tested.has(id) && result.allowed.has(id)).length;

  if (values.verbose) {
    for (const id of result.definedIds) {
      const refs = result.tested.get(id);
      const proof = result.allowed.get(id)?.proof;
      console.log(
        `${id.padEnd(5)} ${refs !== undefined ? refs.join(', ') : proof !== undefined ? `static: ${proof}` : 'MISSING'}`,
      );
    }
  }
  for (const ref of result.skippedRefs) console.warn(`note: ${ref} does not count`);
  for (const id of result.unknownInTests) console.warn(`note: ${id} is named in a test title but not defined in docs`);

  console.log(
    `traceability: ${String(result.definedIds.length)} ids, ${String(byTest)} by test, ${String(byProof)} by static proof, ` +
      `${String(result.missing.length)} missing`,
  );
  for (const problem of result.problems) console.error(`error: ${problem}`);
  if (result.missing.length > 0) console.error(`missing: ${result.missing.join(' ')}`);
  if (result.missing.length > 0 || result.problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) main();
