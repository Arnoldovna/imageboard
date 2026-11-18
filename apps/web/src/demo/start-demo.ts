import { setupWorker } from 'msw/browser';
import { DEMO_SEED } from 'virtual:demo-seed';

import { createDemoHandlers, type ImageSize } from './demo-api';
import { type DemoStore, openDemoStore } from './demo-store';

let storePromise: Promise<DemoStore> | undefined;

/** Tells the demo's other tabs that the data was reset, so they reload instead of showing rows that are gone. */
const RESET_CHANNEL = 'imageboard-demo-reset';

/** Decodes an upload with the browser's own decoder; nothing leaves the page. */
async function readImageSize(blob: Blob): Promise<ImageSize> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Opens the demo database (seeding it on the first visit) and starts Mock Service Worker before the app mounts, so
 * the very first `/api` request is already answered in the browser. Requests outside `/api` (assets, fonts, the seed
 * photos) pass through untouched.
 */
export async function startDemo(): Promise<void> {
  storePromise ??= openDemoStore({
    seed: DEMO_SEED,
    onClosedByNewerVersion: () => {
      window.location.reload();
    },
  });
  const store = await storePromise;
  new BroadcastChannel(RESET_CHANNEL).onmessage = () => {
    window.location.reload();
  };
  const worker = setupWorker(...createDemoHandlers({ store, readImageSize }));
  await worker.start({
    serviceWorker: {
      url: `${import.meta.env.BASE_URL}mockServiceWorker.js`,
      options: { scope: import.meta.env.BASE_URL },
    },
    quiet: true,
    onUnhandledFrame: 'bypass',
  });
}

/** The Reset button: back to the seed (uploads and comments of this browser are gone), then a fresh page. */
export async function resetDemo(): Promise<void> {
  if (storePromise === undefined) throw new Error('The demo has not been started.');
  const store = await storePromise;
  await store.reset();
  const channel = new BroadcastChannel(RESET_CHANNEL);
  channel.postMessage('reset');
  channel.close();
  window.location.reload();
}
