// @ts-check
// Vue app config. Reuses the shared blocks (feature boundaries, ignores, prettier) from the root.
import { vueTsConfigs, withVueTs } from '@vue/eslint-config-typescript';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

import { featureBoundaries, ignores, noImportCycles, prettier } from '../../eslint.shared.js';

export default withVueTs(
  { rootDir: import.meta.dirname, scriptLangs: ['ts'] },
  ignores,
  pluginVue.configs['flat/recommended'],
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
    },
  },
  featureBoundaries({ files: ['src/**/*.{ts,vue}'], tsconfigs: ['tsconfig.app.json'] }),
  noImportCycles({ files: ['src/**/*.{ts,vue}'], tsconfigs: ['tsconfig.app.json'] }),
  prettier,
);
