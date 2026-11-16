import { z } from 'zod';

import type { TextFieldMessages } from './messages.js';

/*
 * One definition of "whitespace" and "forbidden character" for Zod and for the Postgres CHECK constraints
 * (DATA-MODEL §1.1, ADR 0006). The classes are strings of `\uXXXX` escapes and `-` only: they mean the same inside a
 * JS `RegExp` with the `u` flag and inside a Postgres ARE bracket expression (standard_conforming_strings = on), so
 * the Drizzle schema embeds them verbatim. Nothing locale-dependent (`[[:space:]]`, `btrim`) is used.
 */

/** Exactly the set `String.prototype.trim` removes. No leading or trailing whitespace is stored. */
export const WHITESPACE =
  '\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';

/** C0, DEL + C1, line/paragraph separators and bidi embeddings, overrides and isolates (names, titles). */
export const FORBIDDEN_SINGLE_LINE = '\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069';

/** C0 except `\n`, DEL + C1, line/paragraph separators (descriptions, comments). `\r` is normalised away first. */
export const FORBIDDEN_MULTI_LINE = '\\u0001-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u2028\\u2029';

export interface TextFieldOptions {
  min: number;
  max: number;
  messages: TextFieldMessages;
}

/** Length as Postgres `char_length` counts it: code points, not UTF-16 units. */
export function codePointLength(value: string): number {
  // String iteration yields code points; grapheme clusters are deliberately not what Postgres counts.
  return Array.from(value).length;
}

/** `\r\n` and lone `\r` become `\n` (browsers send CRLF in multipart text fields, JSON keeps LF). */
export function normaliseLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

// U+0000 is rejected by Zod only: Postgres `text` cannot store it at all, so the SQL classes start at U+0001.
const forbiddenPattern = (forbidden: string): RegExp => new RegExp(`[\\u0000${forbidden}]`, 'u');
const FORBIDDEN_SINGLE_LINE_PATTERN = forbiddenPattern(FORBIDDEN_SINGLE_LINE);
const FORBIDDEN_MULTI_LINE_PATTERN = forbiddenPattern(FORBIDDEN_MULTI_LINE);

function textField(
  { min, max, messages }: TextFieldOptions,
  normalise: (value: string) => string,
  forbidden: RegExp,
): z.ZodType<string, string> {
  const required = messages.required ?? messages.invalid;
  return z
    .string({ error: required })
    .transform(normalise)
    .superRefine((value, ctx) => {
      // One message per field, in the order a person fixes them: empty, wrong characters, too long.
      const length = codePointLength(value);
      if (length < min) {
        ctx.addIssue({ code: 'custom', message: required });
      } else if (forbidden.test(value)) {
        ctx.addIssue({ code: 'custom', message: messages.invalid });
      } else if (length > max) {
        ctx.addIssue({ code: 'custom', message: messages.tooLong });
      }
    });
}

/** Names and titles: NFC → trim → code points within [min, max] → no line breaks, control or bidi characters. */
export function singleLineText(options: TextFieldOptions): z.ZodType<string, string> {
  return textField(options, (value) => value.normalize('NFC').trim(), FORBIDDEN_SINGLE_LINE_PATTERN);
}

/** Descriptions and comments: `\r\n?` → `\n` → NFC → trim → code points within [min, max] → no control characters. */
export function multiLineText(options: TextFieldOptions): z.ZodType<string, string> {
  return textField(
    options,
    (value) => normaliseLineBreaks(value).normalize('NFC').trim(),
    FORBIDDEN_MULTI_LINE_PATTERN,
  );
}
