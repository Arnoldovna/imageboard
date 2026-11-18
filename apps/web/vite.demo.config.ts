import { msw } from 'msw/vite';
import { defineConfig, mergeConfig } from 'vite';

import { demoSeedPlugin, spaFallbackPlugin } from './build/demo-plugins';
import baseConfig from './vite.config';

/** GitHub Pages serves a project site under the repository name: https://arnoldovna.github.io/imageboard/. */
const DEMO_BASE = '/imageboard/';

/**
 * The static live demo (`pnpm build:demo`, OVERVIEW §19): the real SPA, but `/api` is answered
 * in the browser by Mock Service Worker (src/demo/), persisted in IndexedDB. Built only with `--mode demo`, so
 * `import.meta.env.MODE === 'demo'` is the one switch in the app; the production build never contains MSW
 * (`pnpm check:bundle`).
 */
export default defineConfig((env) => {
  if (env.mode !== 'demo') throw new Error('vite.demo.config.ts must run with --mode demo');
  return mergeConfig(baseConfig(env), {
    base: DEMO_BASE,
    // `worker-only`: emits and serves mockServiceWorker.js under `base`; src/demo/start-demo.ts sets MSW up itself.
    plugins: [msw({ mode: 'worker-only' }), demoSeedPlugin(), spaFallbackPlugin()],
    server: { port: 5174 },
    preview: { port: 4174, strictPort: true },
    build: { outDir: 'dist-demo' },
  });
});
