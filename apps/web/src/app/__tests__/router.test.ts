import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, type RouteLocationNormalizedLoaded } from 'vue-router';

import { ImageDetailDialog } from '../../features/image-detail/index';
import { ROUTE_NAMES } from '../../shared/routing/routes';
import HomePage from '../pages/HomePage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';
import { createAppRouter } from '../router';

function testRouter() {
  return createAppRouter(createMemoryHistory());
}

/** The props function of the matched leaf record, applied like RouterView does. */
function leafProps(route: RouteLocationNormalizedLoaded): unknown {
  const props = route.matched.at(-1)?.props['default'];
  return typeof props === 'function' ? props(route) : props;
}

beforeEach(() => {
  document.title = 'Imageboard';
});

describe('routes (OVERVIEW §8.2)', () => {
  it('serves the gallery page at /', async () => {
    const router = testRouter();
    await router.push('/');

    const route = router.currentRoute.value;
    expect(route.name).toBe(ROUTE_NAMES.home);
    expect(route.matched.map((record) => record.components?.['default'])).toEqual([HomePage]);
  });

  it('renders /images/:id as a child of the gallery, so the gallery stays mounted (ADR 0011)', async () => {
    const router = testRouter();
    await router.push('/images/16');

    const route = router.currentRoute.value;
    expect(route.name).toBe(ROUTE_NAMES.image);
    expect(route.matched.map((record) => record.components?.['default'])).toEqual([HomePage, ImageDetailDialog]);
    expect(leafProps(route)).toEqual({ id: 16 });
  });

  it('passes digit ids beyond the integer range through, so the API answers 400 and the dialog says "not found"', async () => {
    const router = testRouter();
    await router.push('/images/2147483648');

    expect(router.currentRoute.value.name).toBe(ROUTE_NAMES.image);
    expect(leafProps(router.currentRoute.value)).toEqual({ id: 2_147_483_648 });
  });

  it.each(['/images/abc', '/images/1.5', '/images/-1', '/images/', '/upload', '/images/16/comments'])(
    'shows the not-found page for %s',
    async (path) => {
      const router = testRouter();
      await router.push(path);

      const route = router.currentRoute.value;
      expect(route.name).toBe(ROUTE_NAMES.notFound);
      expect(route.matched.map((record) => record.components?.['default'])).toEqual([NotFoundPage]);
    },
  );

  it('uses history paths, never a # (B-59)', async () => {
    const router = testRouter();
    await router.push({ name: ROUTE_NAMES.image, params: { id: '3' } });

    expect(router.currentRoute.value.fullPath).toBe('/images/3');
    expect(router.currentRoute.value.hash).toBe('');
  });
});

describe('document titles (F-53)', () => {
  it('names static routes: "Imageboard" and "Page not found · Imageboard"', async () => {
    const router = testRouter();

    await router.push('/nothing-here');
    expect(document.title).toBe('Page not found · Imageboard');

    await router.push('/');
    expect(document.title).toBe('Imageboard');
  });

  it('leaves the image title to the dialog component', async () => {
    const router = testRouter();
    await router.push('/');
    document.title = 'Tower at sunrise · Imageboard';

    await router.push('/images/16');

    expect(document.title).toBe('Tower at sunrise · Imageboard');
  });

  it('resets to "Imageboard" when the dialog closes', async () => {
    const router = testRouter();
    await router.push('/images/16');
    document.title = 'Tower at sunrise · Imageboard';

    await router.push('/');

    expect(document.title).toBe('Imageboard');
  });
});
