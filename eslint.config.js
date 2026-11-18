// @ts-check
// Root config: packages/shared, apps/api, root scripts and config files.
// apps/web has its own eslint.config.js (ESLint resolves the nearest config per file).
import { defineConfig } from 'eslint/config';
import globals from 'globals';

import { featureBoundaries, ignores, noImportCycles, prettier, typescriptStrict } from './eslint.shared.js';

export default defineConfig([
  ignores,
  ...typescriptStrict(import.meta.dirname),
  { languageOptions: { globals: { ...globals.node } } },
  featureBoundaries({
    files: ['apps/api/src/**/*.ts'],
    tsconfigs: ['apps/api/tsconfig.json', 'packages/*/tsconfig.json'],
    // API features receive ports from app.ts and never import each other, not even an index.ts (OVERVIEW §6).
    crossFeatureImports: false,
  }),
  noImportCycles({
    files: ['apps/api/**/*.ts', 'packages/*/**/*.ts', 'e2e/**/*.ts', 'e2e-demo/**/*.ts', '*.config.ts'],
    tsconfigs: ['apps/api/tsconfig.json', 'packages/*/tsconfig.json', 'tsconfig.json'],
  }),
  {
    // Layering inside a feature (OVERVIEW §6): SQL lives only in repositories, so only *.repository.ts (and tests
    // that seed rows directly) may import drizzle-orm or the table definitions.
    files: ['apps/api/src/features/**/*.ts'],
    ignores: ['apps/api/src/features/**/*.repository.ts', 'apps/api/src/features/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Only *.repository.ts may use drizzle-orm.' },
            { regex: '(^|/)db/schema(/|$)', message: 'Only *.repository.ts may import table definitions.' },
          ],
        },
      ],
    },
  },
  {
    // CLI scripts report to the terminal; no-console guards application code (B-29), not tooling.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/__tests__/**', '**/*.test.ts', 'e2e/**', 'e2e-demo/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
]);
