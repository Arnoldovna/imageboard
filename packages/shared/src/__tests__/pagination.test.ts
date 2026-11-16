import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Cursor, LIMITS, pageOf, pageQuery, requestMessages } from '../index.js';

const ImagesQuery = pageQuery(LIMITS.imagesPage.default, LIMITS.imagesPage.max);

describe('pageQuery', () => {
  it('F-02: missing or empty limit means the default page size', () => {
    expect(ImagesQuery.parse({})).toEqual({ limit: 12, cursor: undefined });
    expect(ImagesQuery.parse({ limit: '' })).toEqual({ limit: 12, cursor: undefined });
  });

  it('uses the default it was built with (page sizes come from the environment)', () => {
    expect(pageQuery(20, 50).parse({}).limit).toBe(20);
  });

  it.each([
    ['1', 1],
    ['12', 12],
    ['50', 50],
    ['51', 50],
    ['1000', 50],
    ['99999999999999999999', 50],
    ['0', 1],
    ['-5', 1],
    ['-0', 1],
  ])('F-02: limit %s is clamped to %i', (raw, expected) => {
    expect(ImagesQuery.parse({ limit: raw }).limit).toBe(expected);
  });

  it.each([['abc'], ['1.5'], ['1e2'], [' 5'], ['5 '], ['0x10'], ['+5']])(
    'F-02 / B-13: non-integer limit %j is a validation error',
    (raw) => {
      const result = ImagesQuery.safeParse({ limit: raw });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ path: ['limit'], message: requestMessages.invalidLimit });
    },
  );

  it('rejects a repeated limit (the simple query parser turns it into an array)', () => {
    expect(ImagesQuery.safeParse({ limit: ['5', '6'] }).success).toBe(false);
  });

  it('passes an opaque cursor through and treats an empty one as the first page', () => {
    expect(ImagesQuery.parse({ cursor: 'eyJ0IjoiMjAyNiJ9' }).cursor).toBe('eyJ0IjoiMjAyNiJ9');
    expect(ImagesQuery.parse({ cursor: '' }).cursor).toBeUndefined();
  });

  it('F-44: rejects a cursor longer than 200 characters', () => {
    const result = ImagesQuery.safeParse({ cursor: 'a'.repeat(LIMITS.cursorMaxLength + 1) });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['cursor'], message: requestMessages.invalidCursor });
    expect(ImagesQuery.safeParse({ cursor: 'a'.repeat(LIMITS.cursorMaxLength) }).success).toBe(true);
  });

  it('rejects unknown query parameters (strict request schemas)', () => {
    expect(ImagesQuery.safeParse({ page: '2' }).success).toBe(false);
  });
});

describe('Cursor', () => {
  it('accepts 1..200 characters', () => {
    expect(Cursor.safeParse('').success).toBe(false);
    expect(Cursor.safeParse('x').success).toBe(true);
  });
});

describe('pageOf', () => {
  const Page = pageOf(z.object({ id: z.number() }));

  it('B-46: accepts a null nextCursor for the last page', () => {
    expect(Page.parse({ items: [{ id: 1 }], nextCursor: null })).toEqual({ items: [{ id: 1 }], nextCursor: null });
  });

  it('is a tolerant reader: unknown members are dropped', () => {
    expect(Page.parse({ items: [], nextCursor: 'c', total: 3 })).toEqual({ items: [], nextCursor: 'c' });
  });

  it('requires both members', () => {
    expect(Page.safeParse({ items: [] }).success).toBe(false);
  });
});
