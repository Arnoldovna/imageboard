import type { CommentDto, CommentPage } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, shallowRef, type EffectScope } from 'vue';

import { useComments } from '../use-comments';

// --- fixtures (seed-like comments on "Fans all the way down", image 6) -------------------------------------------

function comment(id: number, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id,
    imageId: 6,
    authorName: 'Sanne',
    body: 'A long way past the last car park. Worth the walk.',
    createdAt: '2026-10-06T15:52:00.000Z',
    canDelete: false,
    ...overrides,
  };
}

const marit = comment(41, { authorName: 'Marit', body: 'The light on that grass is doing a lot of work.' });
const kofi = comment(40, { authorName: 'Kofi', body: 'Which beach is this?' });
const henrik = comment(37, { authorName: 'Henrik', body: 'The light up there in autumn is something else.' });

// --- fetch stub ------------------------------------------------------------------------------------------------------

type FetchArgs = [input: string, init: RequestInit];
type Handler = (url: string, init: RequestInit) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function page(items: readonly CommentDto[], nextCursor: string | null = null): Response {
  const body: CommentPage = { items: [...items], nextCursor };
  return json(body);
}

function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: `tag:test:problem:${code}`, title: code, status, detail, code, ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const session = (): Response => json({ csrfToken: 'csrf-token-1', uploadMaxBytes: 5 * 1024 * 1024 });

/** A response that never arrives; rejects like `fetch` when its signal aborts. */
function pending(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

/** Answers calls in order; each entry is a response or a handler that sees the request. */
function stubFetch(...answers: (Response | Handler)[]) {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  for (const answer of answers) {
    fetchMock.mockImplementationOnce((url, init) =>
      typeof answer === 'function' ? answer(url, init) : Promise.resolve(answer),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callAt(fetchMock: ReturnType<typeof stubFetch>, index: number): FetchArgs {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`fetch was not called ${String(index + 1)} times`);
  return call;
}

// --- harness ---------------------------------------------------------------------------------------------------------

let scope: EffectScope | null = null;

/** Runs the composable inside an effect scope, as a component's setup would. */
function setup(imageId: number | (() => number) = 6) {
  scope = effectScope();
  const result = scope.run(() => useComments(imageId));
  if (result === undefined) throw new Error('effect scope did not run');
  return result;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  scope?.stop();
  scope = null;
  vi.unstubAllGlobals();
});

// --- tests -----------------------------------------------------------------------------------------------------------

describe('useComments: first page', () => {
  it('loads the newest page of the image on start (F-26, F-27)', async () => {
    const fetchMock = stubFetch(page([marit, kofi], 'cursor-2'));

    const comments = setup(6);
    expect(comments.status.value).toBe('loading');
    await flushPromises();

    expect(comments.status.value).toBe('ready');
    expect(comments.items.value).toEqual([marit, kofi]);
    expect(comments.nextCursor.value).toBe('cursor-2');
    const [url, init] = callAt(fetchMock, 0);
    expect(url).toBe('/api/images/6/comments');
    expect(init.method).toBe('GET');
  });

  it('is ready with no items when the image has no comments (F-30)', async () => {
    stubFetch(page([]));

    const comments = setup();
    await flushPromises();

    expect(comments.status.value).toBe('ready');
    expect(comments.items.value).toEqual([]);
    expect(comments.nextCursor.value).toBeNull();
  });

  it('reports a failed load with the API message and loads again on retry (F-30)', async () => {
    stubFetch(problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'), page([marit]));

    const comments = setup();
    await flushPromises();

    expect(comments.status.value).toBe('error');
    expect(comments.error.value).toBe('Too many requests. Wait a moment and try again.');

    await comments.retry();

    expect(comments.status.value).toBe('ready');
    expect(comments.error.value).toBeNull();
    expect(comments.items.value).toEqual([marit]);
  });

  it('reports a network failure with the service message', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    const comments = setup();
    await flushPromises();

    expect(comments.status.value).toBe('error');
    expect(comments.error.value).toBe('The service is not available right now. Try again in a moment.');
  });

  it('marks a deleted image as notFound instead of a retryable error', async () => {
    stubFetch(problem(404, 'not-found', 'Image was not found.'));

    const comments = setup();
    await flushPromises();

    expect(comments.status.value).toBe('notFound');
    expect(comments.error.value).toBe('Image was not found.');
  });

  it('aborts the previous request and starts over when the image id changes (B-48)', async () => {
    let firstSignal: AbortSignal | null | undefined;
    const fetchMock = stubFetch(
      (_url, init) => {
        firstSignal = init.signal;
        return pending(init);
      },
      page([henrik]),
    );
    const imageId = shallowRef(6);

    const comments = setup(() => imageId.value);
    imageId.value = 7;
    await flushPromises();

    expect(firstSignal?.aborted).toBe(true);
    expect(callAt(fetchMock, 1)[0]).toBe('/api/images/7/comments');
    expect(comments.status.value).toBe('ready');
    expect(comments.items.value).toEqual([henrik]);
  });

  it('clears the previous image comments while the next image loads', async () => {
    const imageId = shallowRef(6);
    stubFetch(page([marit], 'cursor-2'), (_url, init) => pending(init));

    const comments = setup(() => imageId.value);
    await flushPromises();
    imageId.value = 7;
    await flushPromises();

    expect(comments.status.value).toBe('loading');
    expect(comments.items.value).toEqual([]);
    expect(comments.nextCursor.value).toBeNull();
  });

  it('aborts the request in flight when the owning scope stops (dialog closed)', async () => {
    let signal: AbortSignal | null | undefined;
    stubFetch((_url, init) => {
      signal = init.signal;
      return pending(init);
    });

    setup();
    scope?.stop();
    await flushPromises();

    expect(signal?.aborted).toBe(true);
  });
});

describe('useComments: older comments (F-31)', () => {
  it('appends the next page with the cursor and returns the new comments', async () => {
    const fetchMock = stubFetch(page([marit, kofi], 'cursor-2'), page([henrik]));

    const comments = setup();
    await flushPromises();
    const added = await comments.loadMore();

    expect(callAt(fetchMock, 1)[0]).toBe('/api/images/6/comments?cursor=cursor-2');
    expect(added).toEqual([henrik]);
    expect(comments.items.value).toEqual([marit, kofi, henrik]);
    expect(comments.nextCursor.value).toBeNull();
    expect(comments.moreStatus.value).toBe('idle');
  });

  it('never shows a comment twice when pages overlap', async () => {
    stubFetch(page([marit, kofi], 'cursor-2'), page([kofi, henrik], 'cursor-3'));

    const comments = setup();
    await flushPromises();
    const added = await comments.loadMore();

    expect(added).toEqual([henrik]);
    expect(comments.items.value.map((item) => item.id)).toEqual([41, 40, 37]);
    expect(comments.nextCursor.value).toBe('cursor-3');
  });

  it('does nothing without a cursor', async () => {
    const fetchMock = stubFetch(page([marit]));

    const comments = setup();
    await flushPromises();

    expect(await comments.loadMore()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends one request when "show older comments" is pressed twice quickly', async () => {
    const fetchMock = stubFetch(page([marit], 'cursor-2'), page([henrik]));

    const comments = setup();
    await flushPromises();
    await Promise.all([comments.loadMore(), comments.loadMore()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(comments.items.value).toEqual([marit, henrik]);
  });

  it('keeps the loaded comments when an older page fails and retries that page', async () => {
    stubFetch(
      page([marit, kofi], 'cursor-2'),
      problem(500, 'internal-error', 'An unexpected error occurred.'),
      page([henrik]),
    );

    const comments = setup();
    await flushPromises();

    expect(await comments.loadMore()).toBeNull();
    expect(comments.status.value).toBe('ready');
    expect(comments.moreStatus.value).toBe('error');
    expect(comments.error.value).toBe('An unexpected error occurred.');
    expect(comments.items.value).toEqual([marit, kofi]);
    expect(comments.nextCursor.value).toBe('cursor-2');

    await comments.retry();

    expect(comments.moreStatus.value).toBe('idle');
    expect(comments.error.value).toBeNull();
    expect(comments.items.value).toEqual([marit, kofi, henrik]);
  });
});

describe('useComments: add (F-28)', () => {
  const input = { authorName: 'Kofi', body: 'Where does it go?' };

  it('posts with the CSRF token and puts the new comment on top', async () => {
    const created = comment(42, { ...input, canDelete: true, createdAt: '2026-11-16T09:12:00.000Z' });
    const fetchMock = stubFetch(page([marit, kofi]), session(), json(created, 201));

    const comments = setup();
    await flushPromises();
    const result = await comments.add(input);

    expect(result).toEqual({ ok: true, comment: created });
    expect(comments.items.value).toEqual([created, marit, kofi]);
    const [url, init] = callAt(fetchMock, 2);
    expect(url).toBe('/api/images/6/comments');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token-1');
    expect(typeof init.body).toBe('string');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('returns field errors and the message on a validation failure and leaves the list alone (F-29)', async () => {
    stubFetch(
      page([marit]),
      session(),
      problem(400, 'validation-failed', 'The request contains invalid data.', {
        errors: [{ field: 'body', location: 'body', message: 'Comment must be 1,000 characters or fewer.' }],
      }),
    );

    const comments = setup();
    await flushPromises();
    const result = await comments.add(input);

    expect(result).toEqual({
      ok: false,
      message: 'The request contains invalid data.',
      fieldErrors: { body: 'Comment must be 1,000 characters or fewer.' },
    });
    expect(comments.items.value).toEqual([marit]);
  });

  it('returns the message when the image was deleted meanwhile', async () => {
    stubFetch(page([marit]), session(), problem(404, 'not-found', 'Image was not found.'));

    const comments = setup();
    await flushPromises();

    expect(await comments.add(input)).toEqual({ ok: false, message: 'Image was not found.', fieldErrors: {} });
  });

  it('keeps a comment posted while the first page was loading on top when that page arrives', async () => {
    const created = comment(42, { ...input, canDelete: true, createdAt: '2026-11-16T09:12:00.000Z' });
    let answerPage: (response: Response) => void = () => undefined;
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          answerPage = resolve;
        }),
      session(),
      json(created, 201),
    );

    const comments = setup();
    expect((await comments.add(input)).ok).toBe(true);
    // The page's snapshot was taken before the insert.
    answerPage(page([marit, kofi]));
    await flushPromises();

    expect(comments.status.value).toBe('ready');
    expect(comments.items.value).toEqual([created, marit, kofi]);
  });

  it('never shows a comment twice when the first page already contains the one posted meanwhile', async () => {
    const created = comment(42, { ...input, canDelete: true, createdAt: '2026-11-16T09:12:00.000Z' });
    let answerPage: (response: Response) => void = () => undefined;
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          answerPage = resolve;
        }),
      session(),
      json(created, 201),
    );

    const comments = setup();
    await comments.add(input);
    answerPage(page([created, marit]));
    await flushPromises();

    expect(comments.items.value).toEqual([created, marit]);
  });

  it('does not put a comment into another image list when the dialog switched images meanwhile', async () => {
    const imageId = shallowRef(6);
    let answer: ((response: Response) => void) | undefined;
    stubFetch(
      page([marit]),
      session(),
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      page([henrik]),
    );

    const comments = setup(() => imageId.value);
    await flushPromises();
    const posting = comments.add(input);
    await flushPromises();
    imageId.value = 7;
    await flushPromises();
    answer?.(json(comment(42, { ...input, canDelete: true }), 201));
    const result = await posting;

    expect(result.ok).toBe(true);
    expect(comments.items.value).toEqual([henrik]);
  });
});

describe('useComments: remove (F-32)', () => {
  const own = comment(42, { authorName: 'Kofi', body: 'Where does it go?', canDelete: true });

  it('deletes with the CSRF token and drops the comment after the 204', async () => {
    const fetchMock = stubFetch(page([own, marit]), session(), new Response(null, { status: 204 }));

    const comments = setup();
    await flushPromises();
    const result = await comments.remove(42);

    expect(result).toEqual({ ok: true });
    expect(comments.items.value).toEqual([marit]);
    const [url, init] = callAt(fetchMock, 2);
    expect(url).toBe('/api/comments/42');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token-1');
  });

  it('keeps the comment and returns the message when the server refuses (403 not-owner)', async () => {
    stubFetch(page([own, marit]), session(), problem(403, 'not-owner', 'You can only delete comments you wrote.'));

    const comments = setup();
    await flushPromises();
    const result = await comments.remove(42);

    expect(result).toEqual({ ok: false, message: 'You can only delete comments you wrote.' });
    expect(comments.items.value).toEqual([own, marit]);
  });

  it('treats a comment that is already gone (404) as deleted', async () => {
    stubFetch(page([own, marit]), session(), problem(404, 'not-found', 'Comment was not found.'));

    const comments = setup();
    await flushPromises();

    expect(await comments.remove(42)).toEqual({ ok: true });
    expect(comments.items.value).toEqual([marit]);
  });
});
