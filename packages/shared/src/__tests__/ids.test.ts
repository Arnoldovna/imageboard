import { describe, expect, it } from 'vitest';

import { IdParam, LIMITS, requestMessages } from '../index.js';

describe('IdParam', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['2147483647', LIMITS.maxId],
  ])('F-44: accepts %s', (raw, expected) => {
    expect(IdParam.parse(raw)).toBe(expected);
  });

  it.each([
    ['abc'],
    ['0'],
    ['-1'],
    ['1.5'],
    ['1e3'],
    ['01'],
    ['+1'],
    [' 1'],
    ['1 '],
    [''],
    ['2147483648'],
    ['9999999999'],
    ['12345678901'],
    ['0x10'],
  ])('F-44 / B-13: rejects %j with the id message', (raw) => {
    const result = IdParam.safeParse(raw);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([requestMessages.invalidId]);
  });

  it('rejects non-string input (params always arrive as strings)', () => {
    expect(IdParam.safeParse(1).success).toBe(false);
    expect(IdParam.safeParse(undefined).success).toBe(false);
  });
});
