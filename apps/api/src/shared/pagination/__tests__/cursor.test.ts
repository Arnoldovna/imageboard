import { describe, expect, it } from 'vitest';

import { InvalidCursorError } from '../../errors/app-error.js';
import { decodeCursor, encodeCursor, toPage } from '../cursor.js';

const toBase64Url = (value: string) => Buffer.from(value).toString('base64url');

describe('keyset cursor (ADR 0007)', () => {
  it('round-trips a position with millisecond precision', () => {
    const position = { createdAt: new Date('2026-10-06T15:31:00.123Z'), id: 6 };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('accepts the earliest year Postgres can compare (0001)', () => {
    const position = { createdAt: new Date('0001-01-01T00:00:00.000Z'), id: 1 };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is short enough for the 200-character limit even at the largest id', () => {
    expect(encodeCursor({ createdAt: new Date('2026-10-06T15:31:00.123Z'), id: 2_147_483_647 }).length).toBeLessThan(
      200,
    );
  });

  it.each([
    ['not base64url', 'not base64url!'],
    ['not JSON', toBase64Url('{"t":')],
    ['JSON array', toBase64Url('[1,2]')],
    ['missing id', toBase64Url('{"t":"2026-10-06T15:31:00.000Z"}')],
    ['id zero', toBase64Url('{"t":"2026-10-06T15:31:00.000Z","id":0}')],
    ['id above 2^31-1', toBase64Url('{"t":"2026-10-06T15:31:00.000Z","id":2147483648}')],
    ['fractional id', toBase64Url('{"t":"2026-10-06T15:31:00.000Z","id":1.5}')],
    ['timestamp without milliseconds', toBase64Url('{"t":"2026-10-06T15:31:00Z","id":1}')],
    ['not a timestamp', toBase64Url('{"t":"yesterday","id":1}')],
    // Valid ISO 8601, but Postgres has no year 0 and would fail the query with 22008 (a 500).
    ['year 0000', toBase64Url('{"t":"0000-01-01T00:00:00.000Z","id":1}')],
    ['extra keys', toBase64Url('{"t":"2026-10-06T15:31:00.000Z","id":1,"x":1}')],
    ['SQL-looking payload', toBase64Url(`{"t":"2026-10-06T15:31:00.000Z'; drop table images;--","id":1}`)],
  ])('F-44 / B-13: %s is 400 invalid-cursor, never a 500', (_case, raw) => {
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError);
  });
});

describe('toPage', () => {
  const rows = [3, 2, 1].map((id) => ({ id, createdAt: new Date(Date.UTC(2026, 9, id)) }));

  it('B-46: returns a cursor only when the extra row exists', () => {
    const page = toPage(rows, 2);

    expect(page.items.map((row) => row.id)).toEqual([3, 2]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({ id: 2, createdAt: rows[1]?.createdAt });
  });

  it('B-46: a page with exactly `limit` rows is the last page', () => {
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
  });

  it('B-46: an empty result has no cursor', () => {
    expect(toPage([], 12)).toEqual({ items: [], nextCursor: null });
  });
});
