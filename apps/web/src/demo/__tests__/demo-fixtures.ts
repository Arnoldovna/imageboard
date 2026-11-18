import { IDBFactory } from 'fake-indexeddb';
import { getResponse } from 'msw';
import { vi } from 'vitest';

import { createDemoHandlers, type DemoApiOptions } from '../demo-api';
import { type DemoSeed, type DemoStore, openDemoStore } from '../demo-store';

/** The API seed's owner id. */
export const SEED_OWNER_ID = '5eed0000-0000-4000-8000-000000000001';

/** A small seed in the shape of the real one (oldest first, comments oldest first). */
export const SEED: DemoSeed = {
  ownerId: SEED_OWNER_ID,
  images: [
    {
      url: '/imageboard/assets/iris-on-the-axis.jpg',
      width: 1067,
      height: 1600,
      mimeType: 'image/jpeg',
      authorName: 'Marit',
      title: 'Iris on the axis',
      description: 'Everything mirrored down the middle.',
      createdAt: '2026-09-21T06:42:00.000Z',
      comments: [
        {
          authorName: 'Henrik',
          body: 'The little curls on the stems are lovely.',
          createdAt: '2026-09-21T08:05:00.000Z',
        },
        { authorName: 'Bea', body: 'This would make a great book cover.', createdAt: '2026-09-21T12:31:00.000Z' },
      ],
    },
    {
      url: '/imageboard/assets/lotus-frieze.jpg',
      width: 1600,
      height: 900,
      mimeType: 'image/jpeg',
      authorName: 'Jonas from Leipzig',
      title: 'Lotus frieze',
      description: '',
      createdAt: '2026-09-24T23:58:00.000Z',
      comments: [],
    },
    {
      url: '/imageboard/assets/tulips-on-petrol.jpg',
      width: 1600,
      height: 1600,
      mimeType: 'image/jpeg',
      authorName: 'wen',
      title: 'Tulips on petrol',
      description: 'A wallpaper repeat.',
      createdAt: '2026-09-27T09:15:00.000Z',
      comments: [],
    },
  ],
};

export const CSRF_TOKEN = 'csrf-token-1';
export const NOW = '2026-11-18T10:00:00.000Z';
export const ORIGIN = 'https://arnoldovna.github.io';

/** The 8-byte PNG signature plus padding: enough for the magic-byte check; decoding is faked. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

export interface CallInit {
  body?: BodyInit;
  headers?: Record<string, string>;
}

export interface DemoHarness {
  store: DemoStore;
  factory: IDBFactory;
  objectUrls: {
    create: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
    revoke: ReturnType<typeof vi.fn<(url: string) => void>>;
  };
  call: (method: string, path: string, init?: CallInit) => Promise<Response>;
  /** A mutation with the session's CSRF token. */
  mutate: (method: string, path: string, init?: CallInit) => Promise<Response>;
}

export async function demoHarness(
  options: Partial<Omit<DemoApiOptions, 'store'>> & { factory?: IDBFactory } = {},
): Promise<DemoHarness> {
  const factory = options.factory ?? new IDBFactory();
  let owners = 0;
  const store = await openDemoStore({ seed: SEED, factory, newOwnerId: () => `visitor-${String(++owners)}` });
  let urls = 0;
  const objectUrls = {
    create: vi.fn((_blob: Blob) => `blob:${ORIGIN}/upload-${String(++urls)}`),
    revoke: vi.fn((_url: string) => undefined),
  };
  const handlers = createDemoHandlers({
    store,
    readImageSize: () => Promise.resolve({ width: 640, height: 480 }),
    objectUrls,
    now: () => new Date(NOW),
    newCsrfToken: () => CSRF_TOKEN,
    ...options,
  });

  async function call(method: string, path: string, init: CallInit = {}): Promise<Response> {
    const response = await getResponse(handlers, new Request(`${ORIGIN}${path}`, { ...init, method }));
    if (response === undefined) throw new Error(`no handler answered ${method} ${path}`);
    return response;
  }

  const mutate = (method: string, path: string, init: CallInit = {}) =>
    call(method, path, { ...init, headers: { 'x-csrf-token': CSRF_TOKEN, ...init.headers } });

  return { store, factory, objectUrls, call, mutate };
}

export function uploadForm(fields: Record<string, string>, file?: File): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (file !== undefined) form.append('file', file);
  return form;
}

export const pngFile = (bytes: Uint8Array<ArrayBuffer> = PNG_BYTES) =>
  new File([bytes], 'harbour.png', { type: 'image/png' });

export const json = (body: unknown): CallInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
