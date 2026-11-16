import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { CreateCommentBody, CreateImageFields } from '../index.js';
import { fieldMessages, type TextFieldMessages } from '../messages.js';
import { TEXT_FIELDS, TEXT_VECTORS, type TextField } from '../testing/text-vectors.js';
import {
  codePointLength,
  FORBIDDEN_MULTI_LINE,
  FORBIDDEN_SINGLE_LINE,
  multiLineText,
  normaliseLineBreaks,
  singleLineText,
  WHITESPACE,
} from '../text.js';

const SCHEMAS: Record<TextField, z.ZodType<string, string>> = {
  authorName: CreateImageFields.shape.authorName,
  title: CreateImageFields.shape.title,
  description: CreateImageFields.shape.description.unwrap(),
  body: CreateCommentBody.shape.body,
};

const MESSAGES: Record<TextField, TextFieldMessages> = {
  authorName: fieldMessages.authorName,
  title: fieldMessages.title,
  description: fieldMessages.description,
  body: fieldMessages.commentBody,
};

describe.each(Object.keys(TEXT_VECTORS) as TextField[])('F-D3 / B-43: shared text vectors for %s', (field) => {
  const schema = SCHEMAS[field];

  it.each(TEXT_VECTORS[field].map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const result = schema.safeParse(vector.input);

    if ('value' in vector.zod) {
      expect(result.success).toBe(true);
      expect(result.data).toBe(vector.zod.value);
    } else {
      const expected = MESSAGES[field][vector.zod.issue];
      expect(expected).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([expected]);
    }
  });

  it('every value Zod accepts is accepted again unchanged (idempotent normalisation)', () => {
    for (const vector of TEXT_VECTORS[field]) {
      if (!('value' in vector.zod)) continue;
      expect(schema.parse(vector.zod.value)).toBe(vector.zod.value);
    }
  });

  it('covers both boundaries of the limits', () => {
    const { min, max } = TEXT_FIELDS[field];
    const lengths = TEXT_VECTORS[field].map((vector) => codePointLength(vector.input));
    expect(lengths).toContain(max);
    expect(lengths).toContain(max + 1);
    expect(lengths).toContain(min === 0 ? 0 : 1);
  });
});

describe('character classes (DATA-MODEL §1.1)', () => {
  it.each([
    ['WHITESPACE', WHITESPACE],
    ['FORBIDDEN_SINGLE_LINE', FORBIDDEN_SINGLE_LINE],
    ['FORBIDDEN_MULTI_LINE', FORBIDDEN_MULTI_LINE],
  ])('%s contains only \\uXXXX escapes and ranges, so it is safe to embed in SQL', (_name, value) => {
    expect(value).toMatch(/^(?:\\u[0-9A-F]{4}(?:-\\u[0-9A-F]{4})?)+$/);
  });

  it('WHITESPACE is exactly the set String.prototype.trim removes', () => {
    const pattern = new RegExp(`^[${WHITESPACE}]$`, 'u');
    // One assertion over every BMP code point: 65,536 separate expect() calls take seconds and time out under load.
    const mismatches: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      const character = String.fromCharCode(codePoint);
      if (pattern.test(character) !== (character.trim() === '')) {
        mismatches.push(`U+${codePoint.toString(16).padStart(4, '0').toUpperCase()}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('multi-line text allows the line feed but no other C0 control character', () => {
    const pattern = new RegExp(`[${FORBIDDEN_MULTI_LINE}]`, 'u');
    expect(pattern.test('\n')).toBe(false);
    for (let codePoint = 1; codePoint < 0x20; codePoint += 1) {
      if (codePoint === 0x0a) continue;
      expect(pattern.test(String.fromCharCode(codePoint))).toBe(true);
    }
  });
});

describe('text helpers', () => {
  it('counts code points like Postgres char_length', () => {
    expect(codePointLength('a\u{1F600}b')).toBe(3);
    expect('a\u{1F600}b').toHaveLength(4);
  });

  it('normalises CRLF and lone CR to LF', () => {
    expect(normaliseLineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('reports a missing value with the "required" message', () => {
    const schema = singleLineText({ min: 1, max: 5, messages: fieldMessages.title });
    expect(schema.safeParse(undefined).error?.issues[0]?.message).toBe(fieldMessages.title.required);
  });

  it('falls back to the "invalid" message for a non-string optional field', () => {
    const schema = multiLineText({ min: 0, max: 5, messages: fieldMessages.description });
    expect(schema.safeParse(42).error?.issues[0]?.message).toBe(fieldMessages.description.invalid);
  });

  it('reports exactly one message per field, forbidden characters before length', () => {
    const schema = singleLineText({ min: 1, max: 3, messages: fieldMessages.title });
    expect(schema.safeParse('a\nbcdef').error?.issues.map((issue) => issue.message)).toEqual([
      fieldMessages.title.invalid,
    ]);
  });
});
