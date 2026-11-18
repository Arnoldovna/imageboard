// Schibsted Grotesk (SIL OFL 1.1), self-hosted via fontsource: static weights 400 and 500 only (maw-design-system §2).
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import './styles/main.css';

import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router';
import { useSessionStore } from './shared/session/session.store';

// Live demo build only (`vite build --mode demo`): `/api` is answered in the browser before the first request. In every
// other mode the condition is a constant `false`, so the bundler drops the import and MSW never ships (check:bundle).
// If it cannot start (IndexedDB blocked, no service worker and no fetch fallback), the app still mounts: its requests
// then fail like an unreachable API, with the app's own "service is not available" messages instead of a blank page.
if (import.meta.env.MODE === 'demo') {
  try {
    const { startDemo } = await import('./demo/index');
    await startDemo();
  } catch (error) {
    console.error('The live demo could not start its in-browser API.', error);
  }
}

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(createAppRouter());

// Create the anonymous session (CSRF token, upload limit) right away, without blocking the first render; GET requests
// never wait for it and a failure only surfaces on the first mutation (OVERVIEW §4.4).
useSessionStore(pinia).prefetch();

app.mount('#app');
