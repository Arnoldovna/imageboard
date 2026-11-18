import { ImageDto, problemMessages, serviceUnavailable, uploadTooLarge } from '@app/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../session/session.store';
import { GENERIC_ERROR_MESSAGE, INVALID_RESPONSE_MESSAGE } from '../api-error';
import { ApiError, isAbortError, request, withQuery } from '../http';

const image: ImageDto = {
  id: 16,
  url: '/api/media/images/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d5e.jpg',
  previewUrl: '/api/media/previews/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d5e.webp',
  width: 1600,
  height: 1067,
  mimeType: 'image/jpeg',
  authorName: 'Tomás R.',
  title: 'Tower at sunrise',
  description: 'New flat, no lift, but this view makes the stairs bearable.',
  createdAt: '2026-11-12T19:23:00.000Z',
  canDelete: false,
};

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return json(
    { type: `tag:example:problem:${code}`, title: code, status, detail, code, requestId: 'req-12345678', ...extra },
    status,
    'application/problem+json',
  );
}

function session(csrfToken: string, uploadMaxBytes = 5 * 1024 * 1024): Response {
  return json({ csrfToken, uploadMaxBytes });
}

type FetchArgs = [input: string, init: RequestInit];

function stubFetch(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callAt(fetchMock: ReturnType<typeof stubFetch>, index: number): FetchArgs {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`fetch was not called ${String(index + 1)} times`);
  return call;
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.unstubAllGlobals();
});

describe('request: GET', () => {
  it('sends a same-origin GET without waiting for the session and parses the body with the schema', async () => {
    const fetchMock = stubFetch(json({ ...image, extra: 'ignored by the tolerant reader' }));

    const result = await request('GET', '/api/images/16', { schema: ImageDto });

    expect(result).toEqual(image);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = callAt(fetchMock, 0);
    expect(url).toBe('/api/images/16');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeNull();
    expect(headersOf(init).get('x-csrf-token')).toBeNull();
    expect(headersOf(init).get('accept')).toContain('application/problem+json');
  });

  it('turns a body that does not match the schema into an unexpected-response error', async () => {
    stubFetch(json({ ...image, width: 'wide' }));

    const error = await rejection(request('GET', '/api/images/16', { schema: ImageDto }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'unexpected-response', status: 200, detail: INVALID_RESPONSE_MESSAGE });
  });

  it('treats an empty 204 as invalid when a schema expects a body', async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(request('GET', '/api/images/16', { schema: ImageDto })).rejects.toMatchObject({
      code: 'unexpected-response',
    });
  });

  it('maps problem+json to an ApiError with the server detail, field errors and request id', async () => {
    stubFetch(
      problem(400, 'validation-failed', 'The request contains invalid data.', {
        errors: [
          { field: 'title', location: 'body', message: 'Enter a title.' },
          { field: 'title', location: 'body', message: 'Title must be on one line.' },
          { field: 'authorName', location: 'body', message: 'Enter a name.' },
        ],
      }),
    );

    const error = await rejection(request('GET', '/api/images?limit=abc', { schema: ImageDto }));

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('validation-failed');
    expect(apiError.detail).toBe('The request contains invalid data.');
    expect(apiError.fieldErrors).toEqual({ title: 'Enter a title.', authorName: 'Enter a name.' });
    expect(apiError.hasFieldErrors).toBe(true);
    expect(apiError.requestId).toBe('req-12345678');
  });

  it('keeps an unknown problem code from a newer API but shows the generic message', async () => {
    stubFetch(problem(409, 'image-locked', 'Internal wording the client does not know.'));

    await expect(request('GET', '/api/images/16', { schema: ImageDto })).rejects.toMatchObject({
      code: 'image-locked',
      status: 409,
      detail: GENERIC_ERROR_MESSAGE,
    });
  });

  it('maps a non-problem error page (nginx 502) to unexpected-response with the service message', async () => {
    stubFetch(new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));

    await expect(request('GET', '/api/images', { schema: ImageDto })).rejects.toMatchObject({
      code: 'unexpected-response',
      status: 502,
      detail: serviceUnavailable,
    });
  });

  it('maps a rejected fetch to a network error with status 0', async () => {
    stubFetch(new TypeError('Failed to fetch'));

    await expect(request('GET', '/api/images', { schema: ImageDto })).rejects.toMatchObject({
      code: 'network',
      status: 0,
      detail: serviceUnavailable,
    });
  });

  it('passes an abort through as AbortError instead of an ApiError', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(new DOMException('The operation was aborted.', 'AbortError'));

    const error = await rejection(request('GET', '/api/images/1', { schema: ImageDto, signal: controller.signal }));

    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});

describe('request: mutations', () => {
  it('gets the session first, then sends JSON with the CSRF token', async () => {
    const fetchMock = stubFetch(session('token-a'), new Response(null, { status: 204 }));

    await request('POST', '/api/images/16/comments', { body: { authorName: 'Kofi', body: 'Where does it go?' } });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/images/16/comments']);
    const [, init] = callAt(fetchMock, 1);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(headersOf(init).get('x-csrf-token')).toBe('token-a');
    expect(headersOf(init).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{"authorName":"Kofi","body":"Where does it go?"}');
  });

  it('reuses the session token for later mutations', async () => {
    const fetchMock = stubFetch(
      session('token-a'),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );

    await request('DELETE', '/api/comments/3');
    await request('DELETE', '/api/comments/4');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/comments/3', '/api/comments/4']);
    expect(headersOf(callAt(fetchMock, 2)[1]).get('x-csrf-token')).toBe('token-a');
  });

  it('sends FormData as multipart and lets the browser set the content type', async () => {
    const fetchMock = stubFetch(session('token-a'), json({ ...image, canDelete: true }, 201));
    const formData = new FormData();
    formData.set('title', 'Tower at sunrise');

    const created = await request('POST', '/api/images', { formData, schema: ImageDto });

    expect(created.canDelete).toBe(true);
    const [, init] = callAt(fetchMock, 1);
    expect(init.body).toBe(formData);
    expect(headersOf(init).get('content-type')).toBeNull();
    expect(headersOf(init).get('x-csrf-token')).toBe('token-a');
  });

  it('refreshes the session once and retries once after 403 csrf-invalid', async () => {
    const fetchMock = stubFetch(
      session('stale'),
      problem(403, 'csrf-invalid', 'The security token is missing or no longer valid.'),
      session('fresh'),
      new Response(null, { status: 204 }),
    );

    await request('DELETE', '/api/images/16');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/session',
      '/api/images/16',
      '/api/session',
      '/api/images/16',
    ]);
    expect(headersOf(callAt(fetchMock, 3)[1]).get('x-csrf-token')).toBe('fresh');
  });

  it('gives up after the single retry', async () => {
    const fetchMock = stubFetch(
      session('stale'),
      problem(403, 'csrf-invalid', 'Reload the page and try again.'),
      session('fresh'),
      problem(403, 'csrf-invalid', 'Reload the page and try again.'),
    );

    await expect(request('DELETE', '/api/images/16')).rejects.toMatchObject({ code: 'csrf-invalid', status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry other 403s', async () => {
    const fetchMock = stubFetch(
      session('token-a'),
      problem(403, 'not-owner', 'You can only delete images you uploaded.'),
    );

    await expect(request('DELETE', '/api/images/16')).rejects.toMatchObject({
      code: 'not-owner',
      detail: 'You can only delete images you uploaded.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a failed session as the mutation error, without sending the mutation', async () => {
    const fetchMock = stubFetch(problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'));

    await expect(request('POST', '/api/images/16/comments', { body: {} })).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('words an nginx 413 with the upload limit from the session', async () => {
    stubFetch(
      session('token-a', 8 * 1024 * 1024),
      new Response('<html>413</html>', { status: 413, headers: { 'content-type': 'text/html' } }),
    );

    await expect(request('POST', '/api/images', { formData: new FormData() })).rejects.toMatchObject({
      code: 'unexpected-response',
      status: 413,
      detail: uploadTooLarge(8 * 1024 * 1024),
    });
    expect(useSessionStore().uploadMaxBytes).toBe(8 * 1024 * 1024);
  });

  it('never words a 413 for a JSON mutation as an image size problem', async () => {
    stubFetch(
      session('token-a'),
      new Response('<html>413</html>', { status: 413, headers: { 'content-type': 'text/html' } }),
    );

    await expect(request('POST', '/api/images/16/comments', { body: { body: 'Hi' } })).rejects.toMatchObject({
      code: 'unexpected-response',
      status: 413,
      detail: problemMessages['payload-too-large'],
    });
  });
});

describe('withQuery', () => {
  it('appends defined values and skips empty ones', () => {
    expect(withQuery('/api/images', { limit: 12, cursor: 'eyJ0Ijo/IiwiaWQiOjV9' })).toBe(
      '/api/images?limit=12&cursor=eyJ0Ijo%2FIiwiaWQiOjV9',
    );
    expect(withQuery('/api/images', { cursor: '', limit: undefined, other: null })).toBe('/api/images');
  });
});
