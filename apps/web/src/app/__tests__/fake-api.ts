import type { ImageDto } from '@app/shared';
import { vi } from 'vitest';

/**
 * A deterministic stand-in for the API, for app-level tests that mount the real feature modules (they load the
 * gallery, the image and its comments on mount). Without it they would hit happy-dom's real `fetch`.
 *
 * Known: `GET /api/session`, `GET /api/images` (an empty first page, so tests control the gallery through its
 * store), `GET /api/images/:id` (the given images, else 404) and `GET /api/images/:id/comments` (no comments).
 * Anything else is answered with a 404 problem, so a test never waits on the network.
 */
export function stubApi(images: readonly ImageDto[] = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit = {}) => Promise.resolve(answer(images, init.method ?? 'GET', input))),
  );
}

function answer(images: readonly ImageDto[], method: string, input: string): Response {
  const path = input.split('?')[0] ?? input;
  if (method !== 'GET') return notFound();
  if (path === '/api/session') return json({ csrfToken: 'test-csrf-token', uploadMaxBytes: 5 * 1024 * 1024 });
  if (path === '/api/images' || /^\/api\/images\/\d+\/comments$/.test(path)) {
    return json({ items: [], nextCursor: null });
  }
  const id = /^\/api\/images\/(\d+)$/.exec(path)?.[1];
  const image = images.find((item) => String(item.id) === id);
  return image === undefined ? notFound() : json(image);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function notFound(): Response {
  return new Response(
    JSON.stringify({
      type: 'tag:example:problem:not-found',
      title: 'Not found',
      status: 404,
      detail: 'Not found.',
      code: 'not-found',
    }),
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}
