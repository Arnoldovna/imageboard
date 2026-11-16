// @ts-check
// Vue app config. Reuses the shared blocks (feature boundaries, ignores, prettier) from the root.
import { vueTsConfigs, withVueTs } from '@vue/eslint-config-typescript';
import pluginVue from 'eslint-plugin-vue';
import pluginVueA11y from 'eslint-plugin-vuejs-accessibility';
import globals from 'globals';

import { featureBoundaries, ignores, noImportCycles, prettier } from '../../eslint.shared.js';

export default withVueTs(
  { rootDir: import.meta.dirname, scriptLangs: ['ts'] },
  ignores,
  pluginVue.configs['flat/recommended'],
  // Template a11y lint (OVERVIEW §16/§18). Listed before the TypeScript blocks so their parser options win.
  ...pluginVueA11y.configs['flat/recommended'],
  vueTsConfigs.strictTypeChecked,
  vueTsConfigs.stylisticTypeChecked,
  { languageOptions: { globals: { ...globals.browser } } },
  {
    files: ['**/*.vue'],
    rules: {
      'vue/block-lang': ['error', { script: { lang: 'ts' } }],
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/no-v-html': 'error',
      'vue/no-unused-refs': 'error',
      'vue/require-explicit-slots': 'error',
      // A component's `autofocus` falls through to its native element; inside a modal `<dialog>` it is the
      // standard way to set the first focus (ConfirmDialog: "cancel", ADR 0011, F-37). DOM elements stay checked.
      'vuejs-accessibility/no-autofocus': ['error', { ignoreNonDOM: true }],
      // The default demands nesting AND for/id at once; either one associates a label in HTML (WCAG 1.3.1).
      // TextField keeps the label beside the "required" marker, so it uses for/id.
      'vuejs-accessibility/label-has-for': ['error', { required: { some: ['nesting', 'id'] } }],
    },
  },
  {
    // Same as the root config (eslint.shared.js typescriptStrict): `_`-prefixed names mark deliberately unused ones.
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Same as the root config: tests may assert presence with `!` after an explicit expectation.
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  featureBoundaries({ files: ['src/**/*.{ts,vue}'], tsconfigs: ['tsconfig.app.json'] }),
  noImportCycles({ files: ['src/**/*.{ts,vue}'], tsconfigs: ['tsconfig.app.json'] }),
  prettier,
);
