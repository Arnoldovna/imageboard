import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import {
  createImageViaApi,
  createImagesViaApi,
  deleteImageViaApi,
  type ImageInfo,
  uniqueTitle,
} from './support/api.ts';
import {
  busyLoadMoreButton,
  galleryRegion,
  IMAGES_PATH,
  loadMoreButton,
  loadNextPage,
  revealTiles,
  tileLink,
} from './support/screens.ts';
import { createGate, fulfillInternalError } from './support/stubs.ts';

/**
 * Gallery journeys (F-01, F-03 to F-08; B-46, B-57, B-68). Image attributes, layout stability and the responsive
 * grid (F-09, F-10) are in `layout.spec.ts`.
 *
 * The e2e stack is shared by parallel workers and never seeded (ADR 0015): every test creates its own images through
 * `support/api.ts` with unique titles and locates tiles by exact title, never by position or count of the whole
 * gallery. Real-data tests page through the gallery until their own tiles are loaded, because other workers may have
 * uploaded newer images in the meantime. States that depend on what the server holds (empty gallery, last page,
 * failures, a slow response) are produced with `page.route` on `GET /api/images`, answered with DTOs of images this
 * test created, so the previews are real media.
 */

/** `ImagePage` as `GET /api/images` returns it. */
interface ImagePageBody {
  items: readonly ImageInfo[];
  nextCursor: string | null;
}

/** The first page and "load more" requests, but not `/api/images/:id`, uploads or media. */
function isImageListUrl(url: URL): boolean {
  return url.pathname === IMAGES_PATH;
}

function isGet(route: Route): boolean {
  return route.request().method() === 'GET';
}

function cursorOf(route: Route): string {
  return new URL(route.request().url()).searchParams.get('cursor') ?? '';
}

/**
 * Answers `GET /api/images` from `pages`, keyed by cursor (`''` is the first page). A request for any other cursor
 * gets a 500 problem, so a wrong cursor shows up as a visible error. Returns the cursors in request order.
 */
async function serveImagePages(page: Page, pages: ReadonlyMap<string, ImagePageBody>): Promise<string[]> {
  const requested: string[] = [];
  await page.route(isImageListUrl, async (route) => {
    if (!isGet(route)) return route.fallback();
    const cursor = cursorOf(route);
    requested.push(cursor);
    const body = pages.get(cursor);
    return body === undefined ? fulfillInternalError(route) : route.fulfill({ json: body });
  });
  return requested;
}

/** Newest first, like the API: the helpers return images oldest first. */
function newestFirst(images: readonly ImageInfo[]): ImageInfo[] {
  return [...images].reverse();
}

function retryButton(page: Page): Locator {
  return galleryRegion(page).getByRole('button', { name: /^try again$/i });
}

function imagePath(image: ImageInfo): string {
  return `/images/${String(image.id)}`;
}

/** `href` of every tile link in document order. */
function tileHrefs(page: Page): Promise<string[]> {
  return galleryRegion(page)
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
}

function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/** The titles of `images` in the order their tiles appear; each loaded tile is listed as often as it occurs. */
async function shownTitles(page: Page, images: readonly ImageInfo[]): Promise<string[]> {
  const titleByPath = new Map(images.map((image) => [imagePath(image), image.title]));
  const hrefs = await tileHrefs(page);
  return hrefs.flatMap((href) => {
    const title = titleByPath.get(href);
    return title === undefined ? [] : [title];
  });
}

test.describe('gallery with real data', () => {
  test('F-01, F-04: own images appear newest first across "load more" pages, with no duplicate after an upload between two pages', async ({
    page,
    request,
  }) => {
    // 13 images: more than one page (12, F-02), so the oldest one is never on the page its newest one is on.
    const images = await createImagesViaApi(page.request, 13, uniqueTitle('Order'));
    const oldest = images[0]!;
    const newest = images.at(-1)!;

    await page.goto('/');
    await revealTiles(page, [newest.title]);
    await expect(tileLink(page, oldest.title)).toHaveCount(0);

    // A newer image arrives between two page requests (from another visitor). With offset pagination the next page
    // would repeat the last loaded tile; with the keyset cursor it continues exactly after it (F-04).
    const intruder = await createImageViaApi(request, { title: uniqueTitle('Between pages') });

    await revealTiles(page, [oldest.title]);

    expect(await shownTitles(page, images), 'own tiles, each once, newest first').toEqual(
      newestFirst(images).map((image) => image.title),
    );
    expect(duplicatesOf(await tileHrefs(page)), 'tiles shown more than once').toEqual([]);
    // Newer than the cursor: it appears only after the next first-page fetch (F-62), never inside an older page.
    await expect(tileLink(page, intruder.title)).toHaveCount(0);

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-04: deleting an already loaded image between two pages skips no older image', async ({ page }) => {
    const images = await createImagesViaApi(page.request, 13, uniqueTitle('Keyset delete'));
    const oldest = images[0]!;
    const newest = images.at(-1)!;

    await page.goto('/');
    await revealTiles(page, [newest.title]);
    await expect(tileLink(page, oldest.title)).toHaveCount(0);

    // Removing a row the client has already seen shifts every later row up by one. An offset-based next page would
    // therefore skip one image; the keyset cursor must not.
    await deleteImageViaApi(page.request, newest.id);

    await revealTiles(page, [oldest.title]);

    const older = images.slice(0, -1);
    expect(await shownTitles(page, older), 'every older own tile, each once, newest first').toEqual(
      newestFirst(older).map((image) => image.title),
    );
    expect(duplicatesOf(await tileHrefs(page)), 'tiles shown more than once').toEqual([]);

    await expectNoA11yViolations(page);
  });

  test('F-03, B-68: a tile is one link named exactly by the title that shows image, title and author without hover', async ({
    page,
    baseURL,
  }) => {
    const title = uniqueTitle('Tile');
    const authorName = uniqueTitle('Tile author');
    const image = await createImageViaApi(page.request, { title, authorName });

    await page.goto('/');
    await revealTiles(page, [title]);

    const tile = tileLink(page, title);
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toHaveAttribute('href', imagePath(image));
    await expect(tile).toHaveAccessibleName(title);
    await expect(tile).toHaveAccessibleDescription(new RegExp(`^${RegExp.escape(authorName)}\\s`));

    // Title and author are visible text without hovering (touch and screen-reader users get them too). The title is
    // the link's only text (WCAG 2.5.3: visible label inside the name); author and date follow it in the same tile.
    const item = galleryRegion(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: title, exact: true }) });
    await expect(tile.getByText(title, { exact: true })).toBeVisible();
    await expect(tile).toHaveText(title);
    await expect(item.getByText(authorName, { exact: true })).toBeVisible();
    await expect(item.locator('time')).toHaveAttribute('datetime', image.createdAt);

    // The image is inside the link, decorative there (the title names the link), and actually loads.
    const tileImage = tile.locator('img');
    await expect(tileImage).toHaveCount(1);
    await expect(tileImage).toHaveAttribute('alt', '');
    await expect(tileImage).toBeVisible();
    await expect
      .poll(() => tileImage.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), {
        message: 'the tile preview has loaded',
      })
      .toBe(true);

    // One interactive element per tile: nothing focusable is nested inside the link.
    await expect(tile.locator('a, button, [tabindex]')).toHaveCount(0);

    // No id repeats anywhere on the page (the legacy tiles repeated id="title" on every tile).
    const repeatedIds = await page.evaluate(() =>
      [...document.querySelectorAll('[id]')]
        .map((element) => element.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index),
    );
    expect(repeatedIds, 'ids used more than once').toEqual([]);

    // The link is the click target and leads to the image's own URL.
    await tile.click();
    await expect(page).toHaveURL(new URL(imagePath(image), baseURL).href);
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new URL('/', baseURL).href);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(tile).toBeVisible();

    await expectNoA11yViolationsInBothColorSchemes(page);
  });
});

test.describe('gallery states', () => {
  test('F-05, B-46: with no further page there is no "load more" button', async ({ page }) => {
    const images = await createImagesViaApi(page.request, 2, uniqueTitle('Single page'));
    const requested = await serveImagePages(page, new Map([['', { items: newestFirst(images), nextCursor: null }]]));

    await page.goto('/');

    for (const image of images) await expect(tileLink(page, image.title)).toBeVisible();
    await expect(loadMoreButton(page)).toHaveCount(0);
    await expect(busyLoadMoreButton(page)).toHaveCount(0);
    expect(requested).toEqual(['']);

    await expectNoA11yViolations(page);
  });

  test('F-04, F-05: "load more" sends the cursor, appends the next page and disappears after the last one', async ({
    page,
  }) => {
    const images = newestFirst(await createImagesViaApi(page.request, 4, uniqueTitle('Last page')));
    const firstPage = images.slice(0, 3);
    const lastPage = images.slice(3);
    const requested = await serveImagePages(
      page,
      new Map([
        ['', { items: firstPage, nextCursor: 'e2e-cursor-last-page' }],
        ['e2e-cursor-last-page', { items: lastPage, nextCursor: null }],
      ]),
    );

    await page.goto('/');
    for (const image of firstPage) await expect(tileLink(page, image.title)).toBeVisible();
    await expect(tileLink(page, lastPage[0]!.title)).toHaveCount(0);

    await loadNextPage(page);

    expect(await shownTitles(page, images), 'first page, then the appended page').toEqual(
      images.map((image) => image.title),
    );
    await expect(loadMoreButton(page)).toHaveCount(0);
    await expect(
      page.locator('[aria-live="polite"]').filter({ hasText: '1 more image loaded. All images are shown.' }),
    ).toHaveCount(1);
    expect(requested).toEqual(['', 'e2e-cursor-last-page']);

    await expectNoA11yViolations(page);
  });

  test('F-06, B-57: the first page shows a busy loading state until the images arrive', async ({ page }) => {
    const images = await createImagesViaApi(page.request, 2, uniqueTitle('Slow first page'));
    const release = createGate();
    await page.route(isImageListUrl, async (route) => {
      if (!isGet(route)) return route.fallback();
      await release.opened;
      return route.fulfill({ json: { items: newestFirst(images), nextCursor: null } });
    });

    try {
      await page.goto('/');

      const loading = galleryRegion(page).locator('[aria-busy="true"]');
      await expect(loading).toBeVisible();
      await expect(loading.getByText('Loading images…', { exact: true })).toBeVisible();
      await expect(galleryRegion(page).getByRole('link')).toHaveCount(0);
      await expect(galleryRegion(page).getByText('No images yet.')).toHaveCount(0);
    } finally {
      release.open();
    }

    for (const image of images) await expect(tileLink(page, image.title)).toBeVisible();
    await expect(galleryRegion(page).locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(galleryRegion(page).getByText('Loading images…')).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

  test('F-06: while "load more" runs it reads "loading…", is aria-disabled, keeps focus and ignores more presses', async ({
    page,
  }) => {
    const images = newestFirst(await createImagesViaApi(page.request, 4, uniqueTitle('Slow next page')));
    const firstPage = images.slice(0, 3);
    const nextImage = images[3]!;
    const requested: string[] = [];
    const release = createGate();
    await page.route(isImageListUrl, async (route) => {
      if (!isGet(route)) return route.fallback();
      const cursor = cursorOf(route);
      requested.push(cursor);
      if (cursor === '') return route.fulfill({ json: { items: firstPage, nextCursor: 'e2e-cursor-slow' } });
      await release.opened;
      return route.fulfill({ json: { items: [nextImage], nextCursor: null } });
    });

    await page.goto('/');
    await expect(tileLink(page, firstPage[0]!.title)).toBeVisible();

    try {
      await loadMoreButton(page).focus();
      await page.keyboard.press('Enter');

      const busy = busyLoadMoreButton(page);
      await expect(busy).toBeVisible();
      await expect(busy).toHaveAttribute('aria-disabled', 'true');
      await expect(busy).toBeDisabled();
      await expect(busy).toBeFocused();
      await expect(loadMoreButton(page)).toHaveCount(0);

      // Pressing the busy button again must not start a second request.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await expect(busy).toBeFocused();
      expect(requested).toEqual(['', 'e2e-cursor-slow']);
    } finally {
      release.open();
    }

    await expect(tileLink(page, nextImage.title)).toBeVisible();
    await expect(busyLoadMoreButton(page)).toHaveCount(0);
    await expect(loadMoreButton(page)).toHaveCount(0);
    // The control focus was on is gone with the last page: focus continues on the first new tile, not on the page.
    await expect(tileLink(page, nextImage.title)).toBeFocused();
    for (const image of firstPage) await expect(tileLink(page, image.title)).toBeVisible();
    expect(requested).toEqual(['', 'e2e-cursor-slow']);

    await expectNoA11yViolations(page);
  });

  test('F-07, B-46: an empty gallery shows the empty state, whose action opens the upload form', async ({ page }) => {
    await serveImagePages(page, new Map([['', { items: [], nextCursor: null }]]));

    await page.goto('/');

    const region = galleryRegion(page);
    await expect(region.getByText('No images yet.', { exact: true })).toBeVisible();
    await expect(region.getByText('Be the first to upload one.', { exact: true })).toBeVisible();
    await expect(region.getByRole('link')).toHaveCount(0);
    await expect(region.getByRole('list')).toHaveCount(0);
    await expect(loadMoreButton(page)).toHaveCount(0);
    await expect(region.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(region.getByRole('alert')).toHaveCount(0);

    await expectNoA11yViolationsInBothColorSchemes(page);

    const disclosure = page.getByRole('button', { name: 'Upload an image', exact: true });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await region.getByRole('button', { name: 'upload an image', exact: true }).click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel('Name (shown publicly)')).toBeFocused();

    await expectNoA11yViolations(page);
  });

  test('F-08, B-57: a failed first page shows an inline error, and "try again" loads the gallery', async ({ page }) => {
    const images = await createImagesViaApi(page.request, 2, uniqueTitle('Retry first page'));
    const requested: string[] = [];
    await page.route(isImageListUrl, async (route) => {
      if (!isGet(route)) return route.fallback();
      requested.push(cursorOf(route));
      if (requested.length === 1) return fulfillInternalError(route);
      return route.fulfill({ json: { items: newestFirst(images), nextCursor: null } });
    });

    await page.goto('/');

    const region = galleryRegion(page);
    await expect(region.getByRole('alert')).toHaveText(
      'The gallery could not be loaded. An unexpected error occurred.',
    );
    await expect(region.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(region.getByRole('link')).toHaveCount(0);
    await expect(region.getByText('No images yet.')).toHaveCount(0);

    await expectNoA11yViolations(page);

    await retryButton(page).click();

    for (const image of images) await expect(tileLink(page, image.title)).toBeVisible();
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
    // "try again" is gone; focus continues from the section heading instead of dropping to the page.
    await expect(region.getByRole('heading', { name: 'Gallery', exact: true })).toBeFocused();
    expect(requested).toEqual(['', '']);

    await expectNoA11yViolations(page);
  });

  test('F-08, B-57: a failed next page keeps the loaded images, and "try again" loads that page', async ({ page }) => {
    const images = newestFirst(await createImagesViaApi(page.request, 4, uniqueTitle('Retry next page')));
    const firstPage = images.slice(0, 3);
    const nextImage = images[3]!;
    const requested: string[] = [];
    await page.route(isImageListUrl, async (route) => {
      if (!isGet(route)) return route.fallback();
      const cursor = cursorOf(route);
      requested.push(cursor);
      if (cursor === '') return route.fulfill({ json: { items: firstPage, nextCursor: 'e2e-cursor-retry' } });
      // The first attempt fails on the network level (no response at all), the retry succeeds.
      if (requested.length === 2) return route.abort('failed');
      return route.fulfill({ json: { items: [nextImage], nextCursor: null } });
    });

    await page.goto('/');
    await expect(tileLink(page, firstPage[0]!.title)).toBeVisible();

    await loadMoreButton(page).focus();
    await page.keyboard.press('Enter');

    const region = galleryRegion(page);
    await expect(region.getByRole('alert')).toContainText('More images could not be loaded.');
    for (const image of firstPage) await expect(tileLink(page, image.title)).toBeVisible();
    await expect(tileLink(page, nextImage.title)).toHaveCount(0);
    await expect(loadMoreButton(page)).toHaveCount(0);
    // The pressed control was replaced by "try again", and keyboard focus moved there with it.
    await expect(retryButton(page)).toBeFocused();

    await expectNoA11yViolations(page);

    await page.keyboard.press('Enter');

    await expect(tileLink(page, nextImage.title)).toBeVisible();
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
    expect(await shownTitles(page, images), 'loaded tiles kept, the retried page appended').toEqual(
      images.map((image) => image.title),
    );
    expect(requested).toEqual(['', 'e2e-cursor-retry', 'e2e-cursor-retry']);

    await expectNoA11yViolations(page);
  });
});
