import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // `pnpm dev` starts the API with the repository's .env, so the proxy target reads PORT from the same file.
  // An empty `PORT=` means unset, as in the API's env loader.
  const configuredPort = loadEnv(mode, REPO_ROOT, '')['PORT'];
  const apiPort = configuredPort === undefined || configuredPort === '' ? '3000' : configuredPort;

  return {
    plugins: [vue(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin in dev as in production (nginx proxies /api), so cookies stay SameSite=Lax and CORS is unused.
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    },
    build: {
      sourcemap: true,
      // Never inline assets as data: URIs; the nginx CSP allows fonts from 'self' only.
      assetsInlineLimit: 0,
    },
  };
});
