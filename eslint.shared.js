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
  '**/dist-demo/',
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
 * feature only through its public entry point (index.ts). shared/, config/ and db/ never import features;
 * scripts/ (api) and app/ (web) use features only through index.ts; app/ reaches the web demo only through its index.ts.
 * `crossFeatureImports: false` (api, OVERVIEW §6) forbids features to import other features at all, not even their
 * index.ts: the composition root injects ports instead.
 * @param {{ files: string[], tsconfigs: string[], crossFeatureImports?: boolean }} options
 */
export function featureBoundaries({ files, tsconfigs, crossFeatureImports = true }) {
  return {
    files,
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: tsconfigs, noWarnOnMultipleProjects: true },
      },
      'boundaries/elements': [
        // The Zod contract package (`@app/shared`, resolved into packages/shared). Matched on the full path and listed
        // first, so its folder name never classifies it as an app's own `shared` element.
        { type: 'contract', pattern: '**/packages/shared/**', partialMatch: false },
        { type: 'feature', pattern: 'features/*', capture: ['feature'] },
        { type: 'shared', pattern: 'shared' },
        { type: 'config', pattern: 'config' },
        { type: 'db', pattern: 'db' },
        // api: seed and admin entry points (OVERVIEW §6); web: shell, router and pages.
        { type: 'scripts', pattern: 'scripts' },
        { type: 'app', pattern: 'app' },
        // web: the live demo's in-browser API (PLAN Etappe 3b), loaded only in the demo build.
        { type: 'demo', pattern: 'demo' },
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
            // `@app/shared` (contract) is open to everyone (OVERVIEW §6).
            { allow: { to: { element: { type: 'contract' } } } },
            ...(crossFeatureImports
              ? [
                  {
                    from: { element: { type: 'feature' } },
                    allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
                  },
                ]
              : []),
            {
              from: { element: { types: ['feature', 'db'] } },
              allow: { to: { element: { types: ['shared', 'config', 'db'] } } },
            },
            { from: { element: { type: 'shared' } }, allow: { to: { element: { types: ['shared', 'config'] } } } },
            // Entry points outside features use them only through their public index.ts.
            {
              from: { element: { types: ['scripts', 'app'] } },
              allow: { to: { element: { type: 'feature', fileInternalPath: 'index.ts' } } },
            },
            {
              from: { element: { type: 'scripts' } },
              allow: { to: { element: { types: ['shared', 'config', 'db'] } } },
            },
            { from: { element: { type: 'app' } }, allow: { to: { element: { type: 'shared' } } } },
            // The shell mounts the demo banner through the demo's index.ts; the demo uses the app's shared helpers.
            {
              from: { element: { type: 'app' } },
              allow: { to: { element: { type: 'demo', fileInternalPath: 'index.ts' } } },
            },
            { from: { element: { type: 'demo' } }, allow: { to: { element: { type: 'shared' } } } },
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
