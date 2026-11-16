import type { ImageDto, ImagePage } from '@app/shared';
import { cleanup, render, screen, within } from '@testing-library/vue';
import userEvent from '@testing-library/user-event';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { APP_REGION, useAnnouncerStore } from '../../../shared/a11y/announcer.store';
import { ApiError } from '../../../shared/api/api-error';
import { fetchImagePage } from '../gallery.api';
import GallerySection from '../components/GallerySection.vue';
import { useGalleryStore } from '../gallery.store';

vi.mock('../gallery.api', () => ({ fetchImagePage: vi.fn() }));

const fetchPage = vi.mocked(fetchImagePage);

const SEED: readonly (readonly [title: string, author: string])[] = [
  ['Rooftops from the fifth floor', 'Tomás R.'],
  ['Fog over the pines', 'Marit'],
  ['Harbour at dawn', 'Jonas'],
  ['Allotment in late August', 'Ilse'],
  ['Tram depot, Sunday', 'Kemal'],
  ['Laundry between two balconies', 'Aiko'],
  ['Night ferry to Kiel', 'Marit'],
];

function image(id: number): ImageDto {
  const [title, authorName] = SEED[id % SEED.length] ?? ['Untitled', 'Anonymous'];
  const uuid = `0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a${String(id).padStart(4, '0')}`;
  return {
    id,
    url: `/api/media/images/${uuid}.jpg`,
    previewUrl: `/api/media/previews/${uuid}.webp`,
    width: 1600,
    height: 1067,
    mimeType: 'image/jpeg',
    authorName,
    title,
    description: '',
    createdAt: '2026-09-21T12:00:00.000Z',
    canDelete: false,
  };
}

function page(ids: readonly number[], nextCursor: string | null): ImagePage {
  return { items: ids.map(image), nextCursor };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const rateLimited = new ApiError({
  status: 429,
  code: 'rate-limited',
  detail: 'Too many requests. Wait a moment and try again.',
});

const Blank = defineComponent({ render: () => null });

let pinia: Pinia;

async function createTestRouter(): Promise<Router> {
  const testRouter = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        name: 'home',
        component: Blank,
        children: [{ path: 'images/:id', name: 'image', component: Blank }],
      },
    ],
  });
  await testRouter.push('/');
  return testRouter;
}

async function renderGallery() {
  const router = await createTestRouter();
  const view = render(GallerySection, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return view;
}

function announced(): string {
  return useAnnouncerStore().messageFor(APP_REGION);
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  fetchPage.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('GallerySection', () => {
  it('has the "Gallery" h2 as a programmatic focus target', async () => {
    fetchPage.mockResolvedValueOnce(page([1], null));
    await renderGallery();

    const heading = screen.getByRole('heading', { level: 2, name: 'Gallery' });
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('region', { name: 'Gallery' })).toBeTruthy();
  });

  it('shows a busy skeleton while the first page loads, then the tiles (F-06, B-57)', async () => {
    const response = deferred<ImagePage>();
    fetchPage.mockReturnValueOnce(response.promise);
    await renderGallery();

    const label = screen.getByText('Loading images…');
    expect(label.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    response.resolve(page([2, 1], null));
    await flushPromises();

    expect(screen.queryByText('Loading images…')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('renders one link per tile, newest first, named exactly by the visible title (F-01, F-03, F-55, B-68)', async () => {
    fetchPage.mockResolvedValueOnce(page([2, 1], null));
    await renderGallery();

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/images/2', '/images/1']);
    const tile = screen.getByRole('link', { name: 'Fog over the pines' });
    expect(tile).toBe(links[1]);
    expect(within(tile).getByText('Fog over the pines')).toBeTruthy();
    expect(within(tile).getByText('Marit')).toBeTruthy();
    const time = within(tile).getByText('21 Sep 2026');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('datetime')).toBe('2026-09-21T12:00:00.000Z');
    // Author and date describe the link; ids are unique per tile.
    const description = document.getElementById(tile.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Marit 21 Sep 2026');
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the preview with alt="", stored dimensions, async decoding and lazy loading after the first row (F-09)', async () => {
    fetchPage.mockResolvedValueOnce(page([6, 5, 4, 3, 2, 1], null));
    await renderGallery();

    const images = screen.getAllByRole('link').map((link) => link.querySelector('img'));
    expect(images).toHaveLength(6);
    for (const img of images) {
      expect(img?.getAttribute('alt')).toBe('');
      expect(img?.getAttribute('width')).toBe('1600');
      expect(img?.getAttribute('height')).toBe('1067');
      expect(img?.getAttribute('decoding')).toBe('async');
    }
    expect(images[0]?.getAttribute('src')).toBe(image(6).previewUrl);
    expect(images.map((img) => img?.getAttribute('loading'))).toEqual([
      'eager',
      'eager',
      'eager',
      'eager',
      'lazy',
      'lazy',
    ]);
  });

  it('shows the empty state with a button that asks for the upload form, and no "load more" (F-07, B-46)', async () => {
    fetchPage.mockResolvedValueOnce(page([], null));
    const view = await renderGallery();

    expect(screen.getByText('No images yet.')).toBeTruthy();
    expect(screen.getByText('Be the first to upload one.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'load more' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'upload an image' }));

    expect(view.emitted('requestUpload')).toHaveLength(1);
  });

  it('offers "load more" only while nextCursor is set (F-05)', async () => {
    fetchPage.mockResolvedValueOnce(page([3, 2, 1], null));
    await renderGallery();

    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'load more' })).toBeNull();
  });

  it('marks "load more" busy while in flight, appends the page and announces it (F-04, F-06)', async () => {
    fetchPage.mockResolvedValueOnce(page([6, 5], 'cursor-5'));
    await renderGallery();
    const response = deferred<ImagePage>();
    fetchPage.mockReturnValueOnce(response.promise);

    const button = screen.getByRole('button', { name: 'load more' });
    await userEvent.click(button);

    expect(fetchPage).toHaveBeenLastCalledWith({ cursor: 'cursor-5' });
    expect(button.textContent.trim()).toBe('loading…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    await userEvent.click(button);
    expect(fetchPage).toHaveBeenCalledTimes(2);

    response.resolve(page([4, 3], 'cursor-3'));
    await flushPromises();

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/images/6',
      '/images/5',
      '/images/4',
      '/images/3',
    ]);
    expect(button.textContent.trim()).toBe('load more');
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(announced()).toBe('2 more images loaded.');
  });

  it('removes "load more" after the last page and moves focus to the first new tile', async () => {
    fetchPage.mockResolvedValueOnce(page([6, 5], 'cursor-5')).mockResolvedValueOnce(page([4], null));
    await renderGallery();

    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    await flushPromises();

    expect(screen.queryByRole('button', { name: /load more|loading/ })).toBeNull();
    expect(document.activeElement?.getAttribute('href')).toBe('/images/4');
    expect(announced()).toBe('1 more image loaded. All images are shown.');
  });

  it('neither counts nor focuses an upload that lands on top while the last page loads (F-17)', async () => {
    fetchPage.mockResolvedValueOnce(page([6, 5], 'cursor-5'));
    await renderGallery();
    const response = deferred<ImagePage>();
    fetchPage.mockReturnValueOnce(response.promise);

    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    useGalleryStore().prepend(image(7));
    response.resolve(page([4], null));
    await flushPromises();

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/images/7',
      '/images/6',
      '/images/5',
      '/images/4',
    ]);
    expect(announced()).toBe('1 more image loaded. All images are shown.');
    expect(document.activeElement?.getAttribute('href')).toBe('/images/4');
  });

  it('shows an inline error when the first page fails and focuses the heading on retry (F-08, B-57)', async () => {
    fetchPage.mockRejectedValueOnce(rateLimited);
    await renderGallery();

    expect(screen.getByRole('alert').textContent).toBe(
      'The gallery could not be loaded. Too many requests. Wait a moment and try again.',
    );
    expect(screen.queryByText('No images yet.')).toBeNull();

    fetchPage.mockResolvedValueOnce(page([2, 1], null));
    await userEvent.click(screen.getByRole('button', { name: 'try again' }));

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Gallery' }));
    await flushPromises();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('keeps loaded tiles when "load more" fails and retries from the "try again" button (F-08)', async () => {
    fetchPage.mockResolvedValueOnce(page([6, 5], 'cursor-5')).mockRejectedValueOnce(rateLimited);
    await renderGallery();

    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    await flushPromises();

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe(
      'More images could not be loaded. Too many requests. Wait a moment and try again.',
    );
    const retry = screen.getByRole('button', { name: 'try again' });
    expect(document.activeElement).toBe(retry);
    expect(screen.queryByRole('button', { name: 'load more' })).toBeNull();

    const response = deferred<ImagePage>();
    fetchPage.mockReturnValueOnce(response.promise);
    await userEvent.click(retry);

    expect(fetchPage).toHaveBeenLastCalledWith({ cursor: 'cursor-5' });
    expect(document.activeElement?.textContent.trim()).toBe('loading…');
    response.resolve(page([4, 3], 'cursor-3'));
    await flushPromises();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'load more' }));
  });

  it('exposes focusTile(id): the tile link when loaded, else the "Gallery" heading (F-15, ADR 0011)', async () => {
    fetchPage.mockResolvedValueOnce(page([2, 1], null));
    const router = await createTestRouter();
    const wrapper = mount(GallerySection, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();

    wrapper.vm.focusTile(1);
    expect(document.activeElement?.getAttribute('href')).toBe('/images/1');

    wrapper.vm.focusTile(99);
    expect(document.activeElement?.tagName).toBe('H2');

    wrapper.unmount();
  });
});
