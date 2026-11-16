import { LIMITS } from '@app/shared';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../session.store';

function sessionResponse(csrfToken: string, uploadMaxBytes = 4 * 1024 * 1024): Response {
  return new Response(JSON.stringify({ csrfToken, uploadMaxBytes }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({
      type: 'tag:example:problem:rate-limited',
      title: 'Too many requests',
      status: 429,
      detail: 'Too many requests. Wait a moment and try again.',
      code: 'rate-limited',
    }),
    { status: 429, headers: { 'content-type': 'application/problem+json' } },
  );
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.unstubAllGlobals();
});

describe('useSessionStore', () => {
  it('starts idle with the documented upload limit and no token', () => {
    const session = useSessionStore();

    expect(session.status).toBe('idle');
    expect(session.csrfToken).toBeNull();
    expect(session.uploadMaxBytes).toBe(LIMITS.uploadMaxBytesDefault);
  });

  it('loads the token and the effective upload limit from GET /api/session', async () => {
    const fetchMock = stubFetch(sessionResponse('token-a', 4 * 1024 * 1024));
    const session = useSessionStore();

    await expect(session.ensure()).resolves.toBe('token-a');

    expect(fetchMock).toHaveBeenCalledWith('/api/session', expect.objectContaining({ method: 'GET' }));
    expect(session.status).toBe('ready');
    expect(session.csrfToken).toBe('token-a');
    expect(session.uploadMaxBytes).toBe(4 * 1024 * 1024);
  });

  it('shares one request between concurrent callers and answers later calls from memory', async () => {
    const fetchMock = stubFetch(sessionResponse('token-a'));
    const session = useSessionStore();

    const tokens = await Promise.all([session.ensure(), session.ensure(), session.ensure()]);
    const later = await session.ensure();

    expect(tokens).toEqual(['token-a', 'token-a', 'token-a']);
    expect(later).toBe('token-a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failure, keeps no token and tries again on the next call', async () => {
    const fetchMock = stubFetch(rateLimited(), sessionResponse('token-b'));
    const session = useSessionStore();

    await expect(session.ensure()).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
    expect(session.status).toBe('error');
    expect(session.csrfToken).toBeNull();

    await expect(session.ensure()).resolves.toBe('token-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refresh() replaces the token with a new one', async () => {
    stubFetch(sessionResponse('token-a'), sessionResponse('token-b'));
    const session = useSessionStore();
    await session.ensure();

    await expect(session.refresh()).resolves.toBe('token-b');
    expect(session.csrfToken).toBe('token-b');
  });

  it('concurrent refreshes share one request', async () => {
    const fetchMock = stubFetch(sessionResponse('token-a'), sessionResponse('token-b'));
    const session = useSessionStore();
    await session.ensure();

    const tokens = await Promise.all([session.refresh(), session.refresh()]);

    expect(tokens).toEqual(['token-b', 'token-b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('prefetch() starts the session and swallows a failure, so browsing is never blocked', async () => {
    const fetchMock = stubFetch(rateLimited());
    const session = useSessionStore();

    expect(() => {
      session.prefetch();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(session.status).toBe('error');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
