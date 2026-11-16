import { describe, expect, it } from 'vitest';

import { HealthDto } from '../index.js';

describe('HealthDto', () => {
  it.each(['ok', 'unavailable', 'shutting-down'] as const)('accepts status %s', (status) => {
    expect(HealthDto.parse({ status })).toEqual({ status });
  });

  it('is a tolerant reader: unknown keys are dropped, not rejected', () => {
    expect(HealthDto.parse({ status: 'ok', uptime: 12 })).toEqual({ status: 'ok' });
  });

  it('rejects unknown states and missing status', () => {
    expect(HealthDto.safeParse({ status: 'degraded' }).success).toBe(false);
    expect(HealthDto.safeParse({}).success).toBe(false);
  });
});
