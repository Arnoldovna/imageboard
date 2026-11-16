import { describe, expect, it } from 'vitest';

import { isSeedAllowed } from './seed-cli.js';

describe('isSeedAllowed', () => {
  it('requires the explicit SEED_ALLOW=true opt-in', () => {
    expect(isSeedAllowed({ SEED_ALLOW: 'true' })).toBe(true);
    expect(isSeedAllowed({})).toBe(false);
    expect(isSeedAllowed({ SEED_ALLOW: '1' })).toBe(false);
    expect(isSeedAllowed({ SEED_ALLOW: 'TRUE' })).toBe(false);
  });

  it('never derives permission from NODE_ENV', () => {
    expect(isSeedAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(isSeedAllowed({ NODE_ENV: 'test' })).toBe(false);
    expect(isSeedAllowed({ NODE_ENV: 'production', SEED_ALLOW: 'true' })).toBe(true);
  });
});
