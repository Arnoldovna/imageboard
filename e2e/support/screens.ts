import { expect, type Locator, type Page } from '@playwright/test';

import type { ImageInfo } from './api.ts';

/**
 * Locators and navigation shared by the specs, so the markup and wording they depend on live in one place: the
 * gallery region and its tiles, "load more", the detail dialog, the upload disclosure and the message the client
 * shows when no usable response arrives.
 *
 * Other workers upload into the same stack at any time (ADR 0015), so a tile created moments ago is not necessarily
 * on the first gallery page any more: find it with `revealTiles`, never by assuming it is on the first page.
 */

/** `serviceUnavailable` in `packages/shared/src/messages.ts` (client codes `network` and `unexpected-response`). */
export const SERVICE_UNAVAILABLE = 'The service is not available right now. Try again in a moment.';

/** Upper bound on "load more" clicks while looking for tiles (12 per page): a loop guard, not a timing knob. */
const MAX_PAGES = 50;

/** The image list and the upload endpoint (`GET`/`POST /api/images`). */
export const IMAGES_PATH = '/api/images';

export function galleryRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Gallery', exact: true });
}

/** The gallery's `h2`, also the focus target after a dialog closes when no tile can take focus. */
export function galleryHeading(page: Page): Locator {
  return galleryRegion(page).getByRole('heading', { level: 2, name: 'Gallery', exact: true });
}

/** A tile is one link whose accessible name is exactly the image title (F-03, F-55). */
export function tileLink(page: Page, title: string): Locator {
  return galleryRegion(page).getByRole('link', { name: title, exact: true });
}

export function loadMoreButton(page: Page): Locator {
  return galleryRegion(page).getByRole('button', { name: 'load more', exact: true });
}

/** "load more" while its page is in flight. */
export function busyLoadMoreButton(page: Page): Locator {
  return galleryRegion(page).getByRole('button', { name: 'loading…', exact: true });
}

/** Clicks "load more" and waits until that page has arrived and the button is no longer busy. */
export async function loadNextPage(page: Page): Promise<void> {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return url.pathname === IMAGES_PATH && url.searchParams.has('cursor') && candidate.request().method() === 'GET';
  });
  await loadMoreButton(page).click();
  expect((await response).status(), 'next gallery page').toBe(200);
  // The button reads "loading…" until the page has been rendered, so "no busy button" means the tiles are in the DOM.
  await expect(busyLoadMoreButton(page)).toHaveCount(0);
}

/** Waits for the first gallery page, then clicks "load more" until every given title has a tile. */
export async function revealTiles(page: Page, titles: readonly string[]): Promise<void> {
  await expect(galleryRegion(page).getByRole('link').first()).toBeVisible();
  for (let pages = 1; ; pages += 1) {
    const missing: string[] = [];
    for (const title of titles) {
      if ((await tileLink(page, title).count()) === 0) missing.push(title);
    }
    if (missing.length === 0) return;

    const notShown = `tiles not shown yet: ${missing.join(', ')}`;
    expect(pages, `${notShown} (after ${String(MAX_PAGES)} pages)`).toBeLessThan(MAX_PAGES);
    await expect(loadMoreButton(page), `"load more" is offered while ${notShown}`).toBeVisible();
    await loadNextPage(page);
  }
}

/** The detail dialog of an image (or the "Image not found" dialog), named by its heading. */
export function detailDialog(page: Page, title: string): Locator {
  return page.getByRole('dialog', { name: title, exact: true });
}

/** Opens `/images/:id` directly (deep link) and waits until the dialog shows the loaded image. */
export async function openDetail(page: Page, image: ImageInfo): Promise<Locator> {
  await page.goto(`/images/${String(image.id)}`);
  const dialog = detailDialog(page, image.title);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: image.title, exact: true })).toBeVisible();
  return dialog;
}

/** The polite live region that a ModalDialog renders as a direct child of its own `<dialog>` (F-56, ADR 0010). */
export function dialogLiveRegion(dialog: Locator): Locator {
  return dialog.locator(':scope > [aria-live="polite"]');
}

/** The disclosure button of the sticky upload bar (F-57). */
export function uploadToggle(page: Page): Locator {
  return page.getByRole('button', { name: 'Upload an image', exact: true });
}
