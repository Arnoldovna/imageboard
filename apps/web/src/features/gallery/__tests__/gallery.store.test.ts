import { serviceUnavailable, type ImageDto, type ImagePage } from '@app/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INVALID_RESPONSE_MESSAGE } from '../../../shared/api/api-error';
import { useGalleryStore } from '../gallery.store';

/**
 * The store runs against a stubbed `fetch`, so these tests cover the real `gallery.api.ts` and HTTP client too:
 * path and query, schema validation and problem+json mapping.
 */
const TITLES = [
  'Tower at sunrise',
  'Iris on the axis',
  'Harbour at dawn',
  'Allotment in late August',
  'Tram depot, Sunday',
] as const;

function image(id: number): ImageDto {
  const uuid = `0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a${String(id).padStart(4, '0')}`;
  return {
    id,
    url: `/api/media/images/${uuid}.jpg`,
    previewUrl: `/api/media/previews/${uuid}.webp`,
    width: 1600,
    height: 1000,
    mimeType: 'image/jpeg',
    authorName: 'Marit',
    title: TITLES[id % TITLES.length] ?? 'Untitled',
    description: '',
    createdAt: `2026-11-${String(10 + (id % 18)).padStart(2, '0')}T08:30:00.000Z`,
    canDelete: false,
  };
}

function page(ids: readonly number[], nextCursor: string | null): ImagePage {
  return { items: ids.map(image), nextCursor };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: `tag:example:problem:${code}`, title: code, status, detail, code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

interface Deferred {
  promise: Promise<Response>;
  resolve(response: Response): void;
}

function deferred(): Deferred {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fetchMock = vi.fn<typeof fetch>();

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
}

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGalleryStore: first page', () => {
  it('loads the first page newest first with the server page size and same-origin credentials (F-01, F-02)', async () => {
    fetchMock.mockResolvedValueOnce(json(page([16, 15, 14], 'cursor-14')));
    const gallery = useGalleryStore();
    expect(gallery.status).toBe('idle');

    const loading = gallery.loadFirst();
    expect(gallery.status).toBe('loading');
    await loading;

    expect(requestedUrls()).toEqual(['/api/images']);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(gallery.items.map((item) => item.id)).toEqual([16, 15, 14]);
    expect(gallery.nextCursor).toBe('cursor-14');
    expect(gallery.status).toBe('ready');
    expect(gallery.error).toBeNull();
  });

  it('shares one request between concurrent calls and does not reload once ready', async () => {
    const response = deferred();
    fetchMock.mockReturnValueOnce(response.promise);
    const gallery = useGalleryStore();

    const first = gallery.loadFirst();
    const second = gallery.loadFirst();
    response.resolve(json(page([3, 2, 1], null)));
    await Promise.all([first, second]);
    await gallery.loadFirst();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gallery.items).toHaveLength(3);
  });

  it('handles an empty gallery without a cursor and without errors (F-07, B-46)', async () => {
    fetchMock.mockResolvedValueOnce(json(page([], null)));
    const gallery = useGalleryStore();

    await gallery.loadFirst();
    await gallery.loadMore();

    expect(gallery.status).toBe('ready');
    expect(gallery.items).toEqual([]);
    expect(gallery.nextCursor).toBeNull();
    expect(gallery.moreStatus).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an image uploaded while the first page was loading on top, once (F-17)', async () => {
    const response = deferred();
    fetchMock.mockReturnValueOnce(response.promise);
    const gallery = useGalleryStore();

    const loading = gallery.loadFirst();
    gallery.prepend(image(17));
    response.resolve(json(page([17, 16, 15], 'cursor-15')));
    await loading;

    expect(gallery.items.map((item) => item.id)).toEqual([17, 16, 15]);
  });

  it('reports a failed first page with the server message, then retries it (F-08, B-57)', async () => {
    fetchMock
      .mockResolvedValueOnce(problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'))
      .mockResolvedValueOnce(json(page([2, 1], null)));
    const gallery = useGalleryStore();

    await gallery.loadFirst();
    expect(gallery.status).toBe('error');
    expect(gallery.error?.code).toBe('rate-limited');
    expect(gallery.error?.detail).toBe('Too many requests. Wait a moment and try again.');

    await gallery.retry();

    expect(gallery.status).toBe('ready');
    expect(gallery.error).toBeNull();
    expect(gallery.items.map((item) => item.id)).toEqual([2, 1]);
    expect(requestedUrls()).toEqual(['/api/images', '/api/images']);
  });

  it('maps an unreachable API and a body that breaks the contract to user-facing errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ items: [{ id: 'not-a-number' }], nextCursor: null }));
    const gallery = useGalleryStore();

    await gallery.loadFirst();
    expect(gallery.error?.code).toBe('network');
    expect(gallery.error?.detail).toBe(serviceUnavailable);

    await gallery.retry();
    expect(gallery.status).toBe('error');
    expect(gallery.error?.code).toBe('unexpected-response');
    expect(gallery.error?.detail).toBe(INVALID_RESPONSE_MESSAGE);
    expect(gallery.items).toEqual([]);
  });
});

describe('useGalleryStore: load more', () => {
  async function readyStore(ids: readonly number[], cursor: string | null) {
    fetchMock.mockResolvedValueOnce(json(page(ids, cursor)));
    const gallery = useGalleryStore();
    await gallery.loadFirst();
    return gallery;
  }

  it('appends the next page with the opaque cursor until nextCursor is null (F-04, F-05)', async () => {
    const gallery = await readyStore([30, 29, 28], 'eyJpZCI6Mjh9');
    fetchMock
      .mockResolvedValueOnce(json(page([27, 26, 25], 'eyJpZCI6MjV9')))
      .mockResolvedValueOnce(json(page([24], null)));

    await gallery.loadMore();
    await gallery.loadMore();
    await gallery.loadMore();

    expect(requestedUrls()).toEqual([
      '/api/images',
      '/api/images?cursor=eyJpZCI6Mjh9',
      '/api/images?cursor=eyJpZCI6MjV9',
    ]);
    expect(gallery.items.map((item) => item.id)).toEqual([30, 29, 28, 27, 26, 25, 24]);
    expect(gallery.nextCursor).toBeNull();
    expect(gallery.moreStatus).toBe('idle');
  });

  it('never shows an image twice when a later page repeats one (F-04)', async () => {
    const gallery = await readyStore([12, 11, 10], 'cursor-10');
    fetchMock.mockResolvedValueOnce(json(page([10, 9, 8], null)));

    await gallery.loadMore();

    expect(gallery.items.map((item) => item.id)).toEqual([12, 11, 10, 9, 8]);
  });

  it('sends one request for a double click and reports loading meanwhile (F-06)', async () => {
    const gallery = await readyStore([5, 4], 'cursor-4');
    const response = deferred();
    fetchMock.mockReturnValueOnce(response.promise);

    const first = gallery.loadMore();
    const second = gallery.loadMore();
    expect(gallery.moreStatus).toBe('loading');
    response.resolve(json(page([3], null)));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gallery.items.map((item) => item.id)).toEqual([5, 4, 3]);
  });

  it('keeps loaded images when the next page fails and retries the same cursor (F-08)', async () => {
    const gallery = await readyStore([5, 4], 'cursor-4');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(page([3], null)));

    await gallery.loadMore();
    expect(gallery.moreStatus).toBe('error');
    expect(gallery.status).toBe('ready');
    expect(gallery.error?.code).toBe('network');
    expect(gallery.items.map((item) => item.id)).toEqual([5, 4]);
    expect(gallery.nextCursor).toBe('cursor-4');

    await gallery.retry();

    expect(requestedUrls().slice(1)).toEqual(['/api/images?cursor=cursor-4', '/api/images?cursor=cursor-4']);
    expect(gallery.moreStatus).toBe('idle');
    expect(gallery.error).toBeNull();
    expect(gallery.items.map((item) => item.id)).toEqual([5, 4, 3]);
  });

  it('does nothing on retry when nothing failed', async () => {
    const gallery = await readyStore([1], null);

    await gallery.retry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useGalleryStore: upload and delete without reload', () => {
  it('prepends an upload and moves an id that is already loaded instead of duplicating it (F-17)', async () => {
    fetchMock.mockResolvedValueOnce(json(page([3, 2, 1], null)));
    const gallery = useGalleryStore();
    await gallery.loadFirst();

    gallery.prepend(image(4));
    gallery.prepend(image(2));

    expect(gallery.items.map((item) => item.id)).toEqual([2, 4, 3, 1]);
  });

  it('removes a deleted image and keeps pages, cursor and status (F-37, B-47)', async () => {
    fetchMock.mockResolvedValueOnce(json(page([3, 2, 1], 'cursor-1')));
    const gallery = useGalleryStore();
    await gallery.loadFirst();

    gallery.remove(2);

    expect(gallery.items.map((item) => item.id)).toEqual([3, 1]);
    expect(gallery.nextCursor).toBe('cursor-1');
    expect(gallery.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not bring back an image deleted while a page containing it was in flight', async () => {
    fetchMock.mockResolvedValueOnce(json(page([6, 5], 'cursor-5')));
    const gallery = useGalleryStore();
    await gallery.loadFirst();
    const response = deferred();
    fetchMock.mockReturnValueOnce(response.promise);

    const loading = gallery.loadMore();
    gallery.remove(4);
    response.resolve(json(page([4, 3], null)));
    await loading;

    expect(gallery.items.map((item) => item.id)).toEqual([6, 5, 3]);
  });
});
