import type { RouteLocationRaw, Router } from 'vue-router';

/**
 * Route names shared by the router (app/) and the features, which link to and leave routes without importing app/
 * (OVERVIEW §6, §8.2).
 */
export const ROUTE_NAMES = {
  home: 'home',
  image: 'image',
  notFound: 'not-found',
} as const;

export type RouteName = (typeof ROUTE_NAMES)[keyof typeof ROUTE_NAMES];

/** `/images/:id`: the detail dialog over the gallery. */
export function imageLocation(id: number): RouteLocationRaw {
  return { name: ROUTE_NAMES.image, params: { id: String(id) } };
}

/**
 * Leaves a dialog route for the gallery (ADR 0011): when the previous history entry is the gallery, go back, so
 * browser Back and the close button agree and no extra entry is pushed; after a deep link or reload there is no
 * such entry, so replace the current one instead.
 */
export async function leaveToHome(router: Router): Promise<void> {
  if (router.options.history.state['back'] === '/') {
    router.back();
    return;
  }
  await router.replace({ name: ROUTE_NAMES.home });
}
