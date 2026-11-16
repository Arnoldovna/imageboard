import { LIMITS, uploadTooLarge } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { formatBytes } from '../bytes';

describe('formatBytes', () => {
  it('counts small sizes in bytes', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(830)).toBe('830 bytes');
  });

  it('uses whole kilobytes below one megabyte', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(421_888)).toBe('412 KB');
    expect(formatBytes(1500)).toBe('1 KB');
  });

  it('switches to megabytes once a size rounds to 1,024 KB', () => {
    expect(formatBytes(1_048_300)).toBe('1 MB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
  });

  it('writes the upload limit exactly like the API message (F-20)', () => {
    expect(formatBytes(LIMITS.uploadMaxBytesDefault)).toBe('5 MB');
    expect(uploadTooLarge(LIMITS.uploadMaxBytesDefault)).toContain(formatBytes(LIMITS.uploadMaxBytesDefault));
  });

  it('rejects impossible sizes', () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
    expect(() => formatBytes(Number.NaN)).toThrow(RangeError);
  });
});
