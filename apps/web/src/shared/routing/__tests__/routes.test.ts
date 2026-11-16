import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';

import { imageLocation, leaveToHome, ROUTE_NAMES } from '../routes';

const Empty = defineComponent({ render: () => null });

function testRouter(history: RouterHistory = createMemoryHistory()): Router {
  return createRouter({
    history,
    routes: [
      {
        path: '/',
        name: ROUTE_NAMES.home,
        component: Empty,
        children: [{ path: 'images/:id(\\d+)', name: ROUTE_NAMES.image, component: Empty }],
      },
      { path: '/:pathMatch(.*)*', name: ROUTE_NAMES.notFound, component: Empty },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('imageLocation', () => {
  it('resolves to /images/:id', () => {
    expect(testRouter().resolve(imageLocation(42)).fullPath).toBe('/images/42');
  });
});

describe('leaveToHome (ADR 0011)', () => {
  it('goes back when the dialog was opened from the gallery, so no extra history entry is pushed', async () => {
    // Only the browser history records the previous entry in `history.state.back` (the memory history does not).
    window.history.replaceState(null, '', '/');
    const router = testRouter(createWebHistory());
    await router.push('/');
    await router.push(imageLocation(7));
    const back = vi.spyOn(router, 'back');
    const replace = vi.spyOn(router, 'replace');

    await leaveToHome(router);

    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('replaces the entry after a deep link, where Back would leave the app', async () => {
    const router = testRouter();
    await router.push(imageLocation(7));
    const back = vi.spyOn(router, 'back');

    await leaveToHome(router);

    expect(back).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe(ROUTE_NAMES.home);
    expect(router.currentRoute.value.fullPath).toBe('/');
  });
});
