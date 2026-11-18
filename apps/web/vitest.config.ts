import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'unit:web',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    restoreMocks: true,
  },
});
