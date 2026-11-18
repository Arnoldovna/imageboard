import type { ImageDto } from '@app/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { createMemoryHistory, createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';

import { APP_REGION, useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import { formatDateTime } from '../../../shared/format/date';
import { ImageDetailDialog } from '../index';

/**
 * The detail dialog with the real HTTP client on a stubbed `fetch`. `CommentsSection` (agent F's module) is stubbed,
 * so this feature's tests never depend on the comments feature's work in progress (ADR 0021 §2).
 */
const TITLE = 'Tower at sunrise';

function imageDto(overrides: Partial<ImageDto> = {}): ImageDto {
  return {
    id: 16,
    url: '/api/media/images/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d5e.jpg',
    previewUrl: '/api/media/previews/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d5e.webp',
    width: 1600,
    height: 1067,
    mimeType: 'image/jpeg',
    authorName: 'Tomás R.',
    title: TITLE,
    description: 'New flat, no lift.\nBut this view makes the stairs bearable.',
    createdAt: '2026-11-12T19:23:00.000Z',
    canDelete: false,
    ...overrides,
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

type Handler = () => Response | Promise<Response>;

/** Answers `fetch` by "METHOD path"; every handler is a queue, so a route can fail once and then succeed. */
function stubApi(routes: Record<string, Handler[]>) {
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    const queue = routes[key];
    const handler = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
    if (handler === undefined) throw new Error(`unexpected request: ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const session: Handler = () => json({ csrfToken: 'token-for-tests-0123456789', uploadMaxBytes: 5 * 1024 * 1024 });

function requestsTo(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => input === path && (init?.method ?? 'GET') === method)
    .map(([, init]) => init ?? {});
}

/** Route targets only: the dialog is rendered directly, not through a RouterView. */
const Blank = defineComponent({ render: () => null });

let pinia: Pinia;
let router: Router;

/**
 * Renders the dialog at `path`. With `previous` entries the browser history is used, because only it records the
 * previous entry in `history.state.back` (ADR 0011); without, the memory history stands for a deep link.
 */
async function renderAt(path: string, id: number, previous: string[] = []) {
  let history: RouterHistory = createMemoryHistory();
  if (previous.length > 0) {
    window.history.replaceState(null, '', '/');
    history = createWebHistory();
  }
  router = createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: Blank },
      { path: '/images/:id(\\d+)', name: 'image', component: Blank },
    ],
  });
  for (const entry of previous) await router.push(entry);
  await router.push(path);
  await router.isReady();
  const view = render(ImageDetailDialog, {
    props: { id },
    global: { plugins: [pinia, router], stubs: { CommentsSection: true } },
  });
  await flushPromises();
  return view;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  document.title = 'Imageboard';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ImageDetailDialog: states', () => {
  it('shows a loading state while the image loads (F-16)', async () => {
    stubApi({ 'GET /api/images/16': [() => new Promise<Response>(() => undefined)] });

    await renderAt('/images/16', 16);

    const dialog = screen.getByRole('dialog', { name: 'Loading image…' });
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(document.title).toBe('Imageboard');
  });

  it('shows the image, its title as the dialog heading, description, author and date (F-11, F-14, F-54, F-55)', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto())] });

    await renderAt('/images/16', 16);

    const dialog = screen.getByRole('dialog', { name: TITLE });
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe(TITLE);

    const img = within(dialog).getByRole<HTMLImageElement>('img', { name: TITLE });
    expect(img.getAttribute('src')).toBe('/api/media/images/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d5e.jpg');
    expect(img.getAttribute('width')).toBe('1600');
    expect(img.getAttribute('height')).toBe('1067');

    // Line breaks stay in the text; CSS `white-space: pre-line` shows them (never v-html).
    const description = within(dialog).getByText(/New flat, no lift\./);
    expect(description.textContent).toBe('New flat, no lift.\nBut this view makes the stairs bearable.');

    const time = dialog.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-11-12T19:23:00.000Z');
    expect(time?.textContent).toBe(formatDateTime('2026-11-12T19:23:00.000Z'));
    expect(time?.parentElement?.textContent.replace(/\s+/g, ' ').trim()).toBe(
      `Posted by Tomás R. on ${formatDateTime('2026-11-12T19:23:00.000Z')}`,
    );

    expect(document.title).toBe(`${TITLE} · Imageboard`);
  });

  it('renders the description as text, never as markup', async () => {
    stubApi({
      'GET /api/images/16': [() => json(imageDto({ description: '<b>bold</b> <img src=x onerror=alert(1)>' }))],
    });

    await renderAt('/images/16', 16);

    const dialog = screen.getByRole('dialog', { name: TITLE });
    expect(dialog.querySelector('b')).toBeNull();
    expect(within(dialog).getAllByRole('img')).toHaveLength(1);
    expect(within(dialog).getByText('<b>bold</b> <img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('leaves out an empty description', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto({ description: '' }))] });

    await renderAt('/images/16', 16);

    expect(document.querySelector('.image-detail-body__description')).toBeNull();
  });

  it('embeds the comments of the loaded image', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto())] });

    await renderAt('/images/16', 16);

    // Vue Test Utils renders the stub's `imageId` prop as a lowercased attribute.
    const comments = document.querySelector('comments-section-stub');
    expect(comments?.getAttribute('imageid')).toBe('16');
  });

  it('shows "Image not found" with a link back to the gallery on 404 (F-13, B-49)', async () => {
    stubApi({ 'GET /api/images/99': [() => problem(404, 'not-found', 'Image was not found.')] });

    await renderAt('/images/99', 99);

    const dialog = screen.getByRole('dialog', { name: 'Image not found' });
    expect(within(dialog).getByText('This image does not exist or has been deleted.')).toBeTruthy();
    const link = within(dialog).getByRole('link', { name: 'back to the gallery' });
    expect(link.getAttribute('href')).toBe('/');
    expect(document.querySelector('comments-section-stub')).toBeNull();
    expect(document.title).toBe('Image not found · Imageboard');
  });

  it('closes through the "back to the gallery" link without adding a history entry', async () => {
    stubApi({ 'GET /api/images/99': [() => problem(404, 'not-found', 'Image was not found.')] });
    await renderAt('/images/99', 99);
    const replace = vi.spyOn(router, 'replace');
    const push = vi.spyOn(router, 'push');

    await userEvent.click(screen.getByRole('link', { name: 'back to the gallery' }));
    await flushPromises();

    expect(replace).toHaveBeenCalledWith({ name: 'home' });
    expect(push).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('home');
  });

  it('leaves a modified click on "back to the gallery" to the browser (new tab or window)', async () => {
    stubApi({ 'GET /api/images/99': [() => problem(404, 'not-found', 'Image was not found.')] });
    await renderAt('/images/99', 99);
    const replace = vi.spyOn(router, 'replace');
    const back = vi.spyOn(router, 'back');
    const link = screen.getByRole('link', { name: 'back to the gallery' });

    // Records whether the app took the click over, then stops happy-dom from following the link itself.
    const preventedByApp: boolean[] = [];
    const record = (event: Event): void => {
      preventedByApp.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener('click', record);
    try {
      for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
        await fireEvent.click(link, { [modifier]: true });
      }
    } finally {
      document.removeEventListener('click', record);
    }
    await flushPromises();

    expect(preventedByApp).toEqual([false, false, false, false]);
    expect(replace).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Image not found' })).toBeTruthy();
  });

  it('shows a failed load as an alert and loads again on "try again" (B-57)', async () => {
    const fetchMock = stubApi({
      'GET /api/images/16': [
        () => problem(500, 'internal-error', 'An unexpected error occurred.'),
        () => json(imageDto()),
      ],
    });
    await renderAt('/images/16', 16);

    const dialog = screen.getByRole('dialog', { name: 'Image could not be loaded' });
    expect(within(dialog).getByRole('alert').textContent).toBe('An unexpected error occurred.');
    expect(document.title).toBe('Imageboard');

    await userEvent.click(within(dialog).getByRole('button', { name: 'try again' }));
    await flushPromises();

    expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy();
    expect(requestsTo(fetchMock, 'GET', '/api/images/16')).toHaveLength(2);
  });

  it('never shows image A under image B while B loads (F-16, B-48)', async () => {
    let releaseB: (response: Response) => void = () => undefined;
    const fetchMock = stubApi({
      'GET /api/images/1': [() => json(imageDto({ id: 1, title: 'Harbour at dawn' }))],
      'GET /api/images/2': [() => new Promise<Response>((resolve) => (releaseB = resolve))],
    });
    const view = await renderAt('/images/1', 1);
    expect(screen.getByRole('dialog', { name: 'Harbour at dawn' })).toBeTruthy();

    await view.rerender({ id: 2 });
    await flushPromises();

    expect(screen.getByRole('dialog', { name: 'Loading image…' })).toBeTruthy();
    expect(screen.queryByText('Harbour at dawn')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();

    releaseB(json(imageDto({ id: 2, title: 'Iris on the axis' })));
    await flushPromises();

    expect(screen.getByRole('dialog', { name: 'Iris on the axis' })).toBeTruthy();
    expect(requestsTo(fetchMock, 'GET', '/api/images/1')).toHaveLength(1);
    expect(requestsTo(fetchMock, 'GET', '/api/images/2')).toHaveLength(1);
  });
});

describe('ImageDetailDialog: closing (ADR 0011, F-12, F-15)', () => {
  it('goes back when the gallery is the previous history entry', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto())] });
    await renderAt('/images/16', 16, ['/']);
    const back = vi.spyOn(router, 'back');

    await userEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(back).toHaveBeenCalledTimes(1);
  });

  it('replaces the entry with the gallery after a deep link', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto())] });
    await renderAt('/images/16', 16);
    const replace = vi.spyOn(router, 'replace');

    await userEvent.click(screen.getByRole('button', { name: 'close' }));
    await flushPromises();

    expect(replace).toHaveBeenCalledWith({ name: 'home' });
    expect(router.currentRoute.value.fullPath).toBe('/');
  });

  it('closes on Esc, once, even when Esc and "close" arrive before the route changes', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto())] });
    await renderAt('/images/16', 16, ['/']);
    const back = vi.spyOn(router, 'back').mockImplementation(() => undefined);

    document.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }));
    await userEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(back).toHaveBeenCalledTimes(1);
  });

  it('puts the first focus on "close" (no autofocus elsewhere)', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto({ canDelete: true }))] });
    await renderAt('/images/16', 16);

    expect(document.querySelectorAll('[autofocus]')).toHaveLength(0);
    expect(screen.getAllByRole('button')[0]?.textContent.trim()).toBe('close');
  });
});

describe('ImageDetailDialog: delete (F-35 UI, F-37, B-56)', () => {
  it('offers "delete image" only when the session may delete it', async () => {
    stubApi({ 'GET /api/images/16': [() => json(imageDto({ canDelete: false }))] });
    await renderAt('/images/16', 16);

    expect(screen.queryByRole('button', { name: 'delete image' })).toBeNull();
  });

  it('asks for confirmation with focus on "cancel", and cancelling changes nothing', async () => {
    const fetchMock = stubApi({ 'GET /api/images/16': [() => json(imageDto({ canDelete: true }))] });
    const view = await renderAt('/images/16', 16);

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));

    const confirm = screen.getByRole('dialog', { name: 'Delete this image?' });
    expect(within(confirm).getByText('This cannot be undone.')).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: 'cancel' }).hasAttribute('autofocus')).toBe(true);

    await userEvent.click(within(confirm).getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Delete this image?' })).toBeNull();
    expect(requestsTo(fetchMock, 'DELETE', '/api/images/16')).toHaveLength(0);
    expect(view.emitted('deleted')).toBeUndefined();
  });

  it('deletes after confirmation, emits deleted(id), closes and announces "Image deleted."', async () => {
    const fetchMock = stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => new Response(null, { status: 204 })],
    });
    const view = await renderAt('/images/16', 16, ['/']);
    const back = vi.spyOn(router, 'back');

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();

    const [deleteCall] = requestsTo(fetchMock, 'DELETE', '/api/images/16');
    expect(new Headers(deleteCall?.headers).get('x-csrf-token')).toBe('token-for-tests-0123456789');
    expect(view.emitted('deleted')).toEqual([[16]]);
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Delete this image?' })).toBeNull();

    // The route change unmounts the dialog; the announcement then goes to the app's live region.
    view.unmount();
    await nextTick();
    await nextTick();
    expect(useAnnouncerStore().messageFor(APP_REGION)).toBe('Image deleted.');
  });

  it('keeps the image and shows the error when the delete fails (F-37)', async () => {
    stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => problem(403, 'not-owner', 'You can only delete images you uploaded.')],
    });
    const view = await renderAt('/images/16', 16, ['/']);
    const back = vi.spyOn(router, 'back');

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();

    const confirm = screen.getByRole('dialog', { name: 'Delete this image?' });
    expect(within(confirm).getByRole('alert').textContent).toBe('You can only delete images you uploaded.');
    expect(view.emitted('deleted')).toBeUndefined();
    expect(back).not.toHaveBeenCalled();

    await userEvent.click(within(confirm).getByRole('button', { name: 'cancel' }));
    expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy();
    expect(screen.getByRole('img', { name: TITLE })).toBeTruthy();
    // The confirmation already showed that error; it does not come back beside the button.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failure that arrives after cancelling next to the "delete image" button', async () => {
    let answerDelete: (response: Response) => void = () => undefined;
    stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => new Promise<Response>((resolve) => (answerDelete = resolve))],
    });
    const view = await renderAt('/images/16', 16, ['/']);

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete this image?' })).toBeNull();

    answerDelete(problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'));
    await flushPromises();

    const dialog = screen.getByRole('dialog', { name: TITLE });
    expect(within(dialog).getByRole('alert').textContent).toBe('Too many requests. Wait a moment and try again.');
    expect(within(dialog).getByRole('button', { name: 'delete image' }).hasAttribute('aria-disabled')).toBe(false);
    expect(view.emitted('deleted')).toBeUndefined();
  });

  it('returns focus to the busy "delete image" button when the confirmation is cancelled mid-request (WCAG 2.4.3)', async () => {
    let answerDelete: (response: Response) => void = () => undefined;
    const fetchMock = stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => new Promise<Response>((resolve) => (answerDelete = resolve))],
    });
    await renderAt('/images/16', 16, ['/']);
    const deleteButton = screen.getByRole('button', { name: 'delete image' });

    await userEvent.click(deleteButton);
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(deleteButton.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(deleteButton);
    await userEvent.click(deleteButton);
    expect(screen.queryByRole('dialog', { name: 'Delete this image?' })).toBeNull();
    expect(requestsTo(fetchMock, 'DELETE', '/api/images/16')).toHaveLength(1);

    answerDelete(problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.'));
    await flushPromises();
    expect(deleteButton.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(deleteButton);
  });

  it('disables the confirmation while the delete is running, keeping focus on it', async () => {
    const fetchMock = stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => new Promise<Response>(() => undefined)],
    });
    await renderAt('/images/16', 16);

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();

    const confirm = screen.getByRole('button', { name: 'deleting…' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(confirm);

    await userEvent.click(confirm);
    expect(requestsTo(fetchMock, 'DELETE', '/api/images/16')).toHaveLength(1);
  });

  it('treats a 404 on delete as already deleted', async () => {
    stubApi({
      'GET /api/images/16': [() => json(imageDto({ canDelete: true }))],
      'GET /api/session': [session],
      'DELETE /api/images/16': [() => problem(404, 'not-found', 'Image was not found.')],
    });
    const view = await renderAt('/images/16', 16, ['/']);

    await userEvent.click(screen.getByRole('button', { name: 'delete image' }));
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await flushPromises();

    expect(view.emitted('deleted')).toEqual([[16]]);
  });
});
