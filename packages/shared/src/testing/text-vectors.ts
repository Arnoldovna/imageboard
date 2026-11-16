/*
 * Shared accept/reject vectors for every text field (ADR 0006, ADR 0015). `packages/shared` runs them through the Zod
 * schemas; `apps/api/test/db-constraints.int.test.ts` inserts the same `input` strings directly and expects the
 * `db` verdict, so the Zod rules and the SQL CHECK constraints cannot drift apart silently (F-D3, B-43).
 *
 * Exported as `@app/shared/testing`; the web bundle never imports it.
 */
import { LIMITS } from '../limits.js';

export type TextField = 'authorName' | 'title' | 'description' | 'body';

export interface TextFieldSpec {
  readonly kind: 'single-line' | 'multi-line';
  readonly min: number;
  readonly max: number;
}

export const TEXT_FIELDS: Readonly<Record<TextField, TextFieldSpec>> = {
  authorName: { kind: 'single-line', ...LIMITS.authorName },
  title: { kind: 'single-line', ...LIMITS.title },
  description: { kind: 'multi-line', ...LIMITS.description },
  body: { kind: 'multi-line', ...LIMITS.commentBody },
};

/** Which message of `fieldMessages[field]` Zod reports. */
export type TextIssue = 'required' | 'invalid' | 'tooLong';

export interface TextVector {
  readonly name: string;
  /** Raw value as a client could send it and as a direct INSERT would store it. */
  readonly input: string;
  /** Zod: the parsed (normalised) value, or the issue it reports. */
  readonly zod: { readonly value: string } | { readonly issue: TextIssue };
  /**
   * The column CHECK for a direct INSERT of `input` unchanged. `unstorable`: Postgres `text` cannot hold the value
   * at all (U+0000), so the insert fails before any CHECK runs.
   */
  readonly db: 'accept' | 'reject' | 'unstorable';
}

const ok = (value: string) => ({ value });
const issue = (kind: TextIssue) => ({ issue: kind });

/** A grinning face: one code point, two UTF-16 units. Counting must use code points (Postgres `char_length`). */
const ASTRAL = '\u{1F600}';

function lengthVectors(max: number): TextVector[] {
  return [
    { name: 'exactly the maximum', input: 'a'.repeat(max), zod: ok('a'.repeat(max)), db: 'accept' },
    { name: 'one over the maximum', input: 'a'.repeat(max + 1), zod: issue('tooLong'), db: 'reject' },
    {
      name: 'maximum counted in code points (astral characters)',
      input: ASTRAL.repeat(max),
      zod: ok(ASTRAL.repeat(max)),
      db: 'accept',
    },
    {
      name: 'one astral character over the maximum',
      input: ASTRAL.repeat(max + 1),
      zod: issue('tooLong'),
      db: 'reject',
    },
  ];
}

const commonVectors: TextVector[] = [
  { name: 'one character', input: 'a', zod: ok('a'), db: 'accept' },
  { name: 'plain text with inner spaces', input: 'Jonas from Leipzig', zod: ok('Jonas from Leipzig'), db: 'accept' },
  { name: 'precomposed accent', input: 'Lucía', zod: ok('Lucía'), db: 'accept' },
  { name: 'decomposed accent is NFC-normalised', input: 'Lucía', zod: ok('Lucía'), db: 'accept' },
  {
    name: 'emoji sequence with zero-width joiners',
    input: '\u{1F469}‍\u{1F467}',
    zod: ok('\u{1F469}‍\u{1F467}'),
    db: 'accept',
  },
  { name: 'zero-width space is ordinary text', input: 'a​b', zod: ok('a​b'), db: 'accept' },
  { name: 'leading space is trimmed', input: ' Kofi', zod: ok('Kofi'), db: 'reject' },
  { name: 'trailing space is trimmed', input: 'Kofi ', zod: ok('Kofi'), db: 'reject' },
  { name: 'leading no-break space is trimmed', input: ' Kofi', zod: ok('Kofi'), db: 'reject' },
  { name: 'trailing ideographic space is trimmed', input: 'Kofi　', zod: ok('Kofi'), db: 'reject' },
  { name: 'leading byte order mark is trimmed', input: '﻿Kofi', zod: ok('Kofi'), db: 'reject' },
  { name: 'C0 control character', input: 'a\u0007b', zod: issue('invalid'), db: 'reject' },
  { name: 'DEL', input: 'a\u007Fb', zod: issue('invalid'), db: 'reject' },
  { name: 'C1 control character (NEL)', input: 'a\u0085b', zod: issue('invalid'), db: 'reject' },
  { name: 'line separator U+2028', input: 'a b', zod: issue('invalid'), db: 'reject' },
  { name: 'paragraph separator U+2029', input: 'a b', zod: issue('invalid'), db: 'reject' },
  { name: 'tab', input: 'a\tb', zod: issue('invalid'), db: 'reject' },
  {
    name: 'NUL (rejected by Zod, not storable in Postgres)',
    input: 'a\u0000b',
    zod: issue('invalid'),
    db: 'unstorable',
  },
];

function singleLineVectors(max: number): TextVector[] {
  return [
    ...lengthVectors(max),
    ...commonVectors,
    { name: 'empty', input: '', zod: issue('required'), db: 'reject' },
    { name: 'whitespace only', input: ' \t ', zod: issue('required'), db: 'reject' },
    { name: 'line feed', input: 'a\nb', zod: issue('invalid'), db: 'reject' },
    { name: 'CRLF', input: 'a\r\nb', zod: issue('invalid'), db: 'reject' },
    { name: 'bidi override U+202E', input: 'a‮b', zod: issue('invalid'), db: 'reject' },
    { name: 'bidi embedding U+202A', input: 'a‪b', zod: issue('invalid'), db: 'reject' },
    { name: 'bidi isolate U+2066', input: 'a⁦b', zod: issue('invalid'), db: 'reject' },
    { name: 'bidi isolate U+2069', input: 'a⁩b', zod: issue('invalid'), db: 'reject' },
  ];
}

/** `prefix` + (`\r\n` + 'x') × n: normalises to exactly `max` code points while the raw string is longer. */
function crlfAtLimit(max: number): TextVector {
  const repeats = (max - 2) / 2;
  if (!Number.isInteger(repeats)) throw new Error('crlfAtLimit expects an even maximum');
  const input = `xy${'\r\nx'.repeat(repeats)}`;
  return {
    name: 'CRLF text at the limit after normalisation',
    input,
    zod: ok(input.replace(/\r\n/g, '\n')),
    db: 'reject',
  };
}

function multiLineVectors(min: number, max: number): TextVector[] {
  return [
    ...lengthVectors(max),
    ...commonVectors,
    crlfAtLimit(max),
    { name: 'line feed', input: 'a\nb', zod: ok('a\nb'), db: 'accept' },
    { name: 'blank lines are kept', input: 'a\n\n\nb', zod: ok('a\n\n\nb'), db: 'accept' },
    { name: 'CRLF becomes LF', input: 'a\r\nb', zod: ok('a\nb'), db: 'reject' },
    { name: 'lone CR becomes LF', input: 'a\rb', zod: ok('a\nb'), db: 'reject' },
    { name: 'trailing line feed is trimmed', input: 'text\n', zod: ok('text'), db: 'reject' },
    { name: 'vertical tab', input: 'a\u000Bb', zod: issue('invalid'), db: 'reject' },
    { name: 'bidi override is allowed in multi-line text', input: 'a‮b', zod: ok('a‮b'), db: 'accept' },
    min === 0
      ? { name: 'empty', input: '', zod: ok(''), db: 'accept' }
      : { name: 'empty', input: '', zod: issue('required'), db: 'reject' },
    min === 0
      ? { name: 'whitespace only becomes empty', input: ' \n ', zod: ok(''), db: 'reject' }
      : { name: 'whitespace only', input: ' \n ', zod: issue('required'), db: 'reject' },
  ];
}

export const TEXT_VECTORS: Readonly<Record<TextField, readonly TextVector[]>> = {
  authorName: singleLineVectors(LIMITS.authorName.max),
  title: singleLineVectors(LIMITS.title.max),
  description: multiLineVectors(LIMITS.description.min, LIMITS.description.max),
  body: multiLineVectors(LIMITS.commentBody.min, LIMITS.commentBody.max),
};
