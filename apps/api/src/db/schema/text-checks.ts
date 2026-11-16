import { FORBIDDEN_MULTI_LINE, FORBIDDEN_SINGLE_LINE, WHITESPACE } from '@app/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/*
 * CHECK fragments that mirror the shared Zod text rules (DATA-MODEL §1.1, ADR 0006): lengths in code points
 * (`char_length`), no leading/trailing whitespace, no forbidden characters, with the same explicit `\uXXXX` classes.
 * test/db-constraints.int.test.ts runs the shared vectors against these constraints.
 */

// The classes are embedded with sql.raw below. That is safe only because they consist of `\uXXXX` escapes and `-`,
// which is checked here at load time (and by the shared unit tests); they are constants, never user input.
const CLASS_BODY = /^(?:\\u[0-9A-F]{4}(?:-\\u[0-9A-F]{4})?)+$/;
for (const characterClass of [WHITESPACE, FORBIDDEN_SINGLE_LINE, FORBIDDEN_MULTI_LINE]) {
  if (!CLASS_BODY.test(characterClass)) throw new Error('text character classes must be \\uXXXX escapes only');
}

const pattern = (body: string): SQL => sql.raw(`'${body}'`);
const integerLiteral = (value: number): SQL => {
  if (!Number.isSafeInteger(value)) throw new Error('length limits must be integers');
  return sql.raw(String(value));
};

function textCheck(col: AnyPgColumn, min: number, max: number, forbidden: string): SQL {
  return sql`char_length(${col}) BETWEEN ${integerLiteral(min)} AND ${integerLiteral(max)} AND ${col} !~ ${pattern(
    `^[${WHITESPACE}]|[${WHITESPACE}]$`,
  )} AND ${col} !~ ${pattern(`[${forbidden}]`)}`;
}

/** Names and titles: no line breaks, control characters or bidi controls. */
export const singleLine = (col: AnyPgColumn, min: number, max: number): SQL =>
  textCheck(col, min, max, FORBIDDEN_SINGLE_LINE);

/** Descriptions and comments: `\n` is the only control character allowed. */
export const multiLine = (col: AnyPgColumn, min: number, max: number): SQL =>
  textCheck(col, min, max, FORBIDDEN_MULTI_LINE);
