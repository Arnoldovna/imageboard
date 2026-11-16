import { createRouter, createWebHistory, isNavigationFailure, type RouterHistory } from 'vue-router';

import { ImageDetailDialog } from '../features/image-detail/index';
import { setDocumentTitle } from '../shared/dom/use-document-title';
import { ROUTE_NAMES } from '../shared/routing/routes';
import HomePage from './pages/HomePage.vue';
import NotFoundPage from './pages/NotFoundPage.vue';

/**
 * Routes (OVERVIEW §8.2, ADR 0011), history mode so no `#` ever appears (B-59):
 * - `/` the gallery page;
 * - `/images/:id` (digits only) a child of `/`, so the gallery stays mounted behind the detail dialog and keeps its
 *   loaded pages and scroll position; out-of-range ids reach the API, which answers 400, shown as "Image not found";
 * - everything else, including `/images/abc`, the not-found page.
 *
 * Titles: static routes set theirs in `afterEach` from `meta.title`; the image route's component sets its own.
 */
export function createAppRouter(history: RouterHistory = createWebHistory(import.meta.env.BASE_URL)) {
  const router = createRouter({
    history,
    routes: [
      {
        path: '/',
        name: ROUTE_NAMES.home,
        component: HomePage,
        children: [
          {
            path: 'images/:id(\\d+)',
            name: ROUTE_NAMES.image,
            component: ImageDetailDialog,
            props: (route) => ({ id: Number(route.params['id']) }),
            // The dialog sets "<image title> · Imageboard" itself once the image has loaded (useDocumentTitle).
            meta: { titleFromComponent: true },
          },
        ],
      },
      {
        path: '/:pathMatch(.*)*',
        name: ROUTE_NAMES.notFound,
        component: NotFoundPage,
        meta: { title: 'Page not found' },
      },
    ],
    // No `scrollBehavior` (deprecated in Vue Router 5; its replacement is still experimental). Without it the router
    // never scrolls: opening and closing the dialog leaves the gallery where it was, and Back/Forward use the
    // browser's own scroll restoration.
  });

  router.afterEach((to, _from, failure) => {
    if (isNavigationFailure(failure) || to.meta.titleFromComponent === true) return;
    setDocumentTitle(to.meta.title);
  });

  return router;
}
