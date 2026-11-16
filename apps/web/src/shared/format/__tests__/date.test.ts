import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime } from '../date';

describe('formatDate', () => {
  it('writes day, short month and year (maw: 15 Nov 2026)', () => {
    expect(formatDate('2026-11-15T09:30:00.000Z', { timeZone: 'UTC' })).toBe('15 Nov 2026');
  });

  it('writes September as "Sep" in every engine, not ICU\'s en-GB "Sept"', () => {
    expect(formatDate('2026-09-21T12:00:00.000Z', { timeZone: 'UTC' })).toBe('21 Sep 2026');
  });

  it('uses the given time zone for the calendar day', () => {
    expect(formatDate('2026-12-31T23:30:00.000Z', { timeZone: 'UTC' })).toBe('31 Dec 2026');
    expect(formatDate('2026-12-31T23:30:00.000Z', { timeZone: 'Europe/Berlin' })).toBe('1 Jan 2027');
  });

  it('rejects a value that is not a date instead of printing "Invalid Date"', () => {
    expect(() => formatDate('not a date')).toThrow(RangeError);
  });
});

describe('formatDateTime', () => {
  it('adds a 24-hour time after a comma (F-14: 15 Nov 2026, 14:03)', () => {
    expect(formatDateTime('2026-11-15T13:03:00.000Z', { timeZone: 'Europe/Berlin' })).toBe('15 Nov 2026, 14:03');
  });

  it('pads hours and minutes and never prints 24:00', () => {
    expect(formatDateTime('2026-03-01T00:05:00.000Z', { timeZone: 'UTC' })).toBe('1 Mar 2026, 00:05');
  });

  it('formats in the viewer zone by default', () => {
    const iso = '2026-06-10T08:15:00.000Z';
    const local = new Date(iso);
    const expectedTime = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;

    expect(formatDateTime(iso)).toMatch(new RegExp(`, ${expectedTime}$`));
  });
});
