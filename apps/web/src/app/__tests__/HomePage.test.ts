import type { ImageDto } from '@app/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';

import { GallerySection, useGalleryStore } from '../../features/gallery/index';
import { ImageDetailDialog } from '../../features/image-detail/index';
import { UploadPanel } from '../../features/upload/index';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { stubApi } from './fake-api';

/**
 * HomePage is where features meet (ADR 0010): these tests drive the features' public events and exposed methods
 * and check the wiring, independent of how the feature modules render their internals.
 */
function image(id: number, title: string): ImageDto {
  return {
    id,
    url: `/api/media/images/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d${String(id).padStart(2, '0')}.jpg`,
    previewUrl: `/api/media/previews/0b9d3a52-8c1e-4f7a-9d0e-5f1c2b3a4d${String(id).padStart(2, '0')}.webp`,
    width: 1600,
    height: 1000,
    mimeType: 'image/jpeg',
    authorName: 'Marit',
    title,
    description: '',
    createdAt: '2026-09-21T08:30:00.000Z',
    canDelete: true,
  };
}

let pinia: Pinia;
let router: Router;
let wrapper: VueWrapper | undefined;

async function mountAt(path: string): Promise<VueWrapper> {
  router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  wrapper = mount(App, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  stubApi([image(1, 'Harbour at dawn'), image(2, 'Iris on the axis')]);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('HomePage wiring', () => {
  it('puts an uploaded image first in the gallery, without a reload (F-17)', async () => {
    const app = await mountAt('/');
    const gallery = useGalleryStore();
    gallery.prepend(image(1, 'Harbour at dawn'));

    app.findComponent(UploadPanel).vm.$emit('uploaded', image(2, 'Iris on the axis'));
    await nextTick();

    expect(gallery.items.map((item) => item.id)).toEqual([2, 1]);
    expect(app.findComponent(GallerySection).text()).toContain('Iris on the axis');
  });

  it('opens the upload form when the gallery asks for it (empty state, F-07)', async () => {
    const app = await mountAt('/');
    const toggle = app.get('button[aria-controls]');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    app.findComponent(GallerySection).vm.$emit('requestUpload');
    await flushPromises();

    expect(toggle.attributes('aria-expanded')).toBe('true');
  });

  it('opens the detail dialog over the mounted gallery and removes a deleted image from it (F-37)', async () => {
    const gallery = useGalleryStore();
    gallery.prepend(image(1, 'Harbour at dawn'));
    gallery.prepend(image(2, 'Iris on the axis'));
    const app = await mountAt('/');

    await router.push('/images/2');
    await flushPromises();
    expect(app.findComponent(GallerySection).exists()).toBe(true);
    const dialog = app.findComponent(ImageDetailDialog);
    expect(dialog.props('id')).toBe(2);

    dialog.vm.$emit('deleted', 2);
    await nextTick();

    expect(gallery.items.map((item) => item.id)).toEqual([1]);
  });

  it('returns focus to the tile of the image after the dialog closes (F-15)', async () => {
    const gallery = useGalleryStore();
    gallery.prepend(image(1, 'Harbour at dawn'));
    gallery.prepend(image(2, 'Iris on the axis'));
    const app = await mountAt('/');

    await router.push('/images/1');
    await flushPromises();
    await router.push('/');
    await flushPromises();

    expect(app.findComponent(ImageDetailDialog).exists()).toBe(false);
    // The tile link holds only the preview (alt="") and the title, so its text is its accessible name.
    const focused = document.activeElement;
    expect(focused?.getAttribute('href')).toBe('/images/1');
    expect(focused?.textContent.trim()).toBe('Harbour at dawn');
  });

  it('focuses the "Gallery" heading when the tile is not loaded (deep link) or was deleted', async () => {
    const app = await mountAt('/images/99');
    expect(app.findComponent(ImageDetailDialog).exists()).toBe(true);

    await router.replace('/');
    await flushPromises();

    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent.trim()).toBe('Gallery');
  });
});
