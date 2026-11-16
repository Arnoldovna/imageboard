import { serviceUnavailable, type ImageDto } from '@app/shared';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, shallowRef, type EffectScope, type ShallowRef } from 'vue';

import { useImageDetail } from '../use-image-detail';

function imageDto(id: number, title: string): ImageDto {
  return {
    id,
    url: `/api/media/images/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e${String(id).padStart(2, '0')}.jpg`,
    previewUrl: `/api/media/previews/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e${String(id).padStart(2, '0')}.webp`,
    width: 1600,
    height: 1067,
    mimeType: 'image/jpeg',
    authorName: 'Tomás R.',
    title,
    description: 'New flat, no lift, but this view makes the stairs bearable.',
    createdAt: '2026-11-12T19:23:00.000Z',
    canDelete: false,
  };
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string, detail: string): Response {
  return json(
    { type: `tag:example:problem:${code}`, title: code, status, detail, code },
    status,
    'application/problem+json',
  );
}

interface PendingCall {
  url: string;
  signal: AbortSignal;
  respond(response: Response): void;
}

/**
 * A `fetch` whose answers the test hands out one by one, so it can let a request for image A finish after the
 * route has moved on to image B. Like the real `fetch`, it rejects with an `AbortError` when its signal aborts.
 */
function controllableFetch() {
  const calls: PendingCall[] = [];
  const fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const signal = init.signal ?? new AbortController().signal;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
      calls.push({ url: input, signal, respond: resolve });
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  function call(index: number): PendingCall {
    const pending = calls[index];
    if (pending === undefined) throw new Error(`fetch was not called ${String(index + 1)} times`);
    return pending;
  }

  return { fetchMock, call };
}

let scope: EffectScope | undefined;

/** Runs the composable inside its own effect scope, as a component's setup would. */
function useInScope(id: ShallowRef<number>) {
  scope = effectScope();
  const result = scope.run(() => useImageDetail(id));
  if (result === undefined) throw new Error('effect scope did not run');
  return result;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  scope?.stop();
  scope = undefined;
  vi.unstubAllGlobals();
});

describe('useImageDetail', () => {
  it('starts in the loading state and fetches the image once (F-16, B-48)', async () => {
    const { fetchMock, call } = controllableFetch();
    const id = shallowRef(16);

    const { state, image } = useInScope(id);

    expect(state.value).toEqual({ status: 'loading', id: 16 });
    expect(image.value).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).url).toBe('/api/images/16');

    call(0).respond(json(imageDto(16, 'Rooftops from the fifth floor')));
    await flushPromises();

    expect(state.value.status).toBe('ready');
    expect(image.value?.title).toBe('Rooftops from the fifth floor');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again while the id stays the same', async () => {
    const { fetchMock, call } = controllableFetch();
    const id = shallowRef(16);
    useInScope(id);
    call(0).respond(json(imageDto(16, 'Rooftops from the fifth floor')));
    await flushPromises();

    id.value = 16;
    await nextTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the request for A when the id changes to B and never shows A under B (F-16)', async () => {
    const { fetchMock, call } = controllableFetch();
    const id = shallowRef(1);
    const { state, image } = useInScope(id);

    id.value = 2;
    await nextTick();

    expect(call(0).signal.aborted).toBe(true);
    expect(state.value).toEqual({ status: 'loading', id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).url).toBe('/api/images/2');

    // A late answer for A must not land in B's state.
    call(0).respond(json(imageDto(1, 'Harbour at dawn')));
    await flushPromises();
    expect(state.value).toEqual({ status: 'loading', id: 2 });

    call(1).respond(json(imageDto(2, 'Fog over the pines')));
    await flushPromises();
    expect(image.value?.id).toBe(2);
    expect(image.value?.title).toBe('Fog over the pines');
  });

  it('switches to loading at once when moving from a loaded image to another one', async () => {
    const { call } = controllableFetch();
    const id = shallowRef(1);
    const { state, image } = useInScope(id);
    call(0).respond(json(imageDto(1, 'Harbour at dawn')));
    await flushPromises();
    expect(state.value.status).toBe('ready');

    id.value = 2;
    await nextTick();

    expect(state.value).toEqual({ status: 'loading', id: 2 });
    expect(image.value).toBeNull();
  });

  it('reports a 404 as not found instead of breaking the render (F-13, B-49)', async () => {
    const { call } = controllableFetch();
    const { state, image } = useInScope(shallowRef(99));

    call(0).respond(problem(404, 'not-found', 'Image was not found.'));
    await flushPromises();

    expect(state.value).toEqual({ status: 'notFound', id: 99 });
    expect(image.value).toBeNull();
  });

  it('reports the API 400 for an id out of range as not found (ADR 0011)', async () => {
    const { call } = controllableFetch();
    const { state } = useInScope(shallowRef(2_000_000_000));

    call(0).respond(problem(400, 'validation-failed', 'The request contains invalid data.'));
    await flushPromises();

    expect(state.value).toEqual({ status: 'notFound', id: 2_000_000_000 });
  });

  it.each([0, 2_147_483_648, Number.POSITIVE_INFINITY])(
    'shows %s as not found without asking the API, which cannot know it',
    (value) => {
      const { fetchMock } = controllableFetch();

      const { state } = useInScope(shallowRef(value));

      expect(state.value).toEqual({ status: 'notFound', id: value });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('keeps the error message and loads again on retry', async () => {
    const { fetchMock, call } = controllableFetch();
    const { state, image, retry } = useInScope(shallowRef(16));

    call(0).respond(problem(500, 'internal-error', 'An unexpected error occurred.'));
    await flushPromises();
    expect(state.value).toEqual({ status: 'error', id: 16, message: 'An unexpected error occurred.' });

    retry();
    expect(state.value).toEqual({ status: 'loading', id: 16 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    call(1).respond(json(imageDto(16, 'Rooftops from the fifth floor')));
    await flushPromises();
    expect(image.value?.title).toBe('Rooftops from the fifth floor');
  });

  it('turns a failed connection into the "not available" message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const { state } = useInScope(shallowRef(16));
    await flushPromises();

    expect(state.value).toEqual({ status: 'error', id: 16, message: serviceUnavailable });
  });

  it('treats a body that does not match the contract as an error, not as an image', async () => {
    const { call } = controllableFetch();
    const { state } = useInScope(shallowRef(16));

    call(0).respond(json({ id: 16, title: 'Rooftops from the fifth floor' }));
    await flushPromises();

    expect(state.value.status).toBe('error');
  });

  it('aborts the request when its owner goes away', () => {
    const { call } = controllableFetch();
    useInScope(shallowRef(16));

    scope?.stop();

    expect(call(0).signal.aborted).toBe(true);
  });
});
