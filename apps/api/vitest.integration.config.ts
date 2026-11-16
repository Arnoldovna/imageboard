import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration:api',
    environment: 'node',
    include: ['src/**/*.int.test.ts', 'test/**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
