import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, type Response, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from '../e2e/a11y.ts';
import { imageFixture } from '../e2e/support/files.ts';
import {
  detailDialog,
  galleryHeading,
  galleryRegion,
  loadMoreButton,
  tileLink,
  uploadToggle,
} from '../e2e/support/screens.ts';

/**
 * Live demo smoke (PLAN Etappe 3b): the real SPA from `pnpm build:demo` under /imageboard/, its API answered in the
 * browser by Mock Service Worker from IndexedDB. Seed titles are the real seed's (apps/api/src/scripts/seed-content.ts).
 */

const DIST = join(import.meta.dirname, '..', 'apps', 'web', 'dist-demo');
const BANNER_TEXT = 'Demo – Daten bleiben nur in deinem Browser';
/** The newest and the oldest picture of the real seed. */
const NEWEST_SEED_TITLE = 'Medallion with stars';
const OLDEST_SEED_TITLE = 'Peacock';

/** Every `/api` response the page sees; each must have come from the service worker, none from the network. */
function recordApiResponses(page: Page): Response[] {
  const responses: Response[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/')) responses.push(response);
  });
  return responses;
}

async function openGallery(page: Page): Promise<void> {
  await page.goto('./');
  await expect(galleryHeading(page)).toBeVisible();
  await expect(galleryRegion(page).getByRole('link').first()).toBeVisible();
}

test.describe('live demo', () => {
  test('shows the seeded gallery from the in-browser API, with the banner, the footer and no axe violations', async ({
    page,
  }) => {
    const apiResponses = recordApiResponses(page);
    await openGallery(page);

    const banner = page.getByRole('complementary', { name: 'Live demo' });
    await expect(banner).toContainText(BANNER_TEXT);
    await expect(banner.getByRole('button', { name: 'reset demo', exact: true })).toBeVisible();

    // The real seed: 16 pictures, 12 per page, newest first; the seed picture decodes from the hashed asset.
    await expect(galleryRegion(page).getByRole('listitem')).toHaveCount(12);
    await expect(galleryRegion(page).getByRole('listitem').first().getByRole('link')).toHaveAccessibleName(
      NEWEST_SEED_TITLE,
    );
    await expect(loadMoreButton(page)).toBeVisible();
    // Tile images are decorative (alt=""): the link carries the title.
    const firstImage = galleryRegion(page).locator('img').first();
    await expect
      .poll(() => firstImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    expect(new URL(await firstImage.evaluate((img: HTMLImageElement) => img.currentSrc)).pathname).toMatch(
      /^\/imageboard\/assets\//,
    );

    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'GitHub', exact: true })).toBeVisible();
    await expect(page.getByRole('contentinfo').getByRole('link', { name: /imprint|impressum/i })).toHaveCount(0);

    expect(apiResponses.length, 'the gallery requested the API').toBeGreaterThan(0);
    for (const response of apiResponses) {
      expect(response.fromServiceWorker(), `${response.url()} answered in the browser`).toBe(true);
    }

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('keeps an upload and a comment in IndexedDB across a reload, until "reset demo" restores the seed in every tab', async ({
    page,
  }) => {
    const title = 'Harbour at dusk';
    await openGallery(page);

    await uploadToggle(page).click();
    const form = page.locator('form', { has: page.getByLabel('Name (shown publicly)', { exact: true }) });
    await form.getByLabel('Name (shown publicly)', { exact: true }).fill('Kofi');
    await form.getByLabel('Title', { exact: true }).fill(title);
    await form
      .getByRole('button', { name: /^Image choose (an|another) image$/ })
      .setInputFiles(imageFixture('landscapeJpeg'));
    await form.getByRole('button', { name: 'upload image', exact: true }).click();

    // The upload is the first tile, shown from a blob: URL; its bytes never left the browser.
    const tile = tileLink(page, title);
    await expect(tile).toBeVisible();
    await expect(galleryRegion(page).getByRole('listitem').first().getByRole('link')).toHaveAccessibleName(title);
    await expect
      .poll(() => tile.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    expect(await tile.locator('img').evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(/^blob:/);

    // A comment on the upload, through the detail dialog.
    await tile.click();
    const dialog = detailDialog(page, title);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name (shown publicly)', { exact: true }).fill('Bea');
    await dialog.getByLabel('Comment', { exact: true }).fill('Lovely light.');
    await dialog.getByRole('button', { name: 'post comment', exact: true }).click();
    await expect(dialog.getByText('Lovely light.', { exact: true })).toBeVisible();
    await expectNoA11yViolations(page, { include: 'dialog[open]' });

    // Deep link after a reload: the SPA fallback boots on /imageboard/images/17 and IndexedDB still has both.
    await page.reload();
    await expect(detailDialog(page, title)).toBeVisible();
    await expect(detailDialog(page, title).getByText('Lovely light.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tileLink(page, title)).toBeVisible();

    // A second tab of the same browser shows the upload too, until the reset in the first tab reloads it.
    const otherTab = await page.context().newPage();
    await otherTab.goto('./');
    await expect(tileLink(otherTab, title)).toBeVisible();

    await page.getByRole('button', { name: 'reset demo', exact: true }).click();
    for (const tab of [page, otherTab]) {
      await expect(galleryRegion(tab).getByRole('listitem').first().getByRole('link')).toHaveAccessibleName(
        NEWEST_SEED_TITLE,
      );
      await expect(tileLink(tab, title)).toHaveCount(0);
    }
  });

  test('protects the seed: a visitor cannot delete what they did not create', async ({ page }) => {
    await page.goto('images/1');
    const dialog = detailDialog(page, OLDEST_SEED_TITLE);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img', { name: OLDEST_SEED_TITLE, exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /delete/ })).toHaveCount(0);
  });

  test('is built for GitHub Pages: base path, worker and the SPA fallback 404.html', async ({ page }) => {
    expect(existsSync(join(DIST, 'mockServiceWorker.js'))).toBe(true);
    expect(readFileSync(join(DIST, '404.html'), 'utf8')).toBe(readFileSync(join(DIST, 'index.html'), 'utf8'));

    await page.goto('no-such-page');
    await expect(page).toHaveTitle('Page not found · Imageboard');
    await expect(page.getByRole('complementary', { name: 'Live demo' })).toBeVisible();
  });
});
