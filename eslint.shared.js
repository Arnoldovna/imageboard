// @ts-check
// Building blocks shared by the root config and app-level configs (ESLint resolves the nearest
// eslint.config.js per file, so apps/web can add framework rules while reusing these).
import js from '@eslint/js';
import { globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import boundaries from 'eslint-plugin-boundaries';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export const ignores = globalIgnores([
  '**/dist/',
  '**/coverage/',
  '**/playwright-report/',
  '**/test-results/',
  '**/drizzle/',
  '**/.vite/',
]);

/** @param {string} rootDir */
export function typescriptStrict(rootDir) {
  return [
    {
      files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
      extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: rootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'no-console': 'error',
        eqeqeq: ['error', 'always'],
      },
    },
    { files: ['**/*.{js,mjs,cjs}'], extends: [tseslint.configs.disableTypeChecked] },
  ];
}

/**
 * Feature isolation: files inside features/<name>/ may import their own files freely, but another
 * feature only through its public entry point (index.ts). shared/, config/ and db/ never import features.
 * @param {{ files: string[], tsconfigs: string[] }} options
 */
export function featureBoundaries({ files, tsconfigs }) {
  return {
    files,
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: tsconfigs, noWarnOnMultipleProjects: true },
      },
      'boundaries/elements': [
        { type: 'feature', pattern: 'features/*', capture: ['feature'] },
        { type: 'shared', pattern: 'shared' },
        { type: 'config', pattern: 'config' },
        { type: 'db', pattern: 'db' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            { allow: { to: { module: { origin: 'external' } } } },
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            {
              from: { element: { type: 'feature' } },
              allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
            },
            {
              from: { element: { types: ['feature', 'db'] } },
              allow: { to: { element: { types: ['shared', 'config', 'db'] } } },
            },
            { from: { element: { type: 'shared' } }, allow: { to: { element: { types: ['shared', 'config'] } } } },
          ],
        },
      ],
    },
  };
}

/**
 * No import cycles anywhere (conventions §9): feature modules stay acyclic, also through their index.ts.
 * @param {{ files: string[], tsconfigs: string[] }} options
 */
export function noImportCycles({ files, tsconfigs }) {
  return {
    files,
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ alwaysTryTypes: true, project: tsconfigs, noWarnOnMultipleProjects: true }),
        createNodeResolver(),
      ],
    },
    rules: {
      // Type-only imports are erased at runtime, but a type cycle is still a design cycle: count them too.
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
    },
  };
}

export { prettier };
