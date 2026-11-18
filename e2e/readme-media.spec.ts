import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

import { deleteImageViaApi, getImageViaApi } from './support/api.ts';
import { detailDialog, galleryRegion, IMAGES_PATH, tileLink, uploadToggle } from './support/screens.ts';

/**
 * README media (portfolio-readme skill), run by `pnpm media:readme` against the seeded `pnpm demo` stack, never by
 * `pnpm test:e2e`. Writes the four standard screenshots, the detail dialog and `raw/upload-flow.webm`. The clip
 * uploads one image and deletes it again, so the demo data ends as it started. Convert the clip for the README with
 *
 *   ffmpeg -i docs/media/raw/upload-flow.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/media/upload-flow.gif
 *
 * and keep every PNG under 1 MB and the GIF under 3 MB. `docs/media/raw/` is git-ignored.
 */

const OUT = process.env['MEDIA_OUT_DIR'] ?? 'docs/media';
const RAW = path.join(OUT, 'raw');
const UPLOAD_FILE = 'apps/api/seed/images/iris-on-the-axis.jpg';
const UPLOAD_TITLE = 'Iris, second try';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * Every image of `scope` that is in the viewport has loaded and is decoded (`decoding="async"`: a loaded image can
 * still be undecoded, and the screenshot then shows the grey placeholder). Images outside the viewport are left alone:
 * lazy tiles below the fold do not load while nothing scrolls to them.
 */
async function imagesInViewReady(scope: Locator): Promise<void> {
  await expect
    .poll(() =>
      scope.locator('img').evaluateAll(async (images: HTMLImageElement[]) => {
        const inView = images.filter((img) => {
          const box = img.getBoundingClientRect();
          return box.bottom > 0 && box.top < innerHeight;
        });
        if (!inView.every((img) => img.complete && img.naturalWidth > 0)) return false;
        await Promise.all(inView.map((img) => img.decode()));
        return true;
      }),
    )
    .toBe(true);
}

/** Fonts loaded and every tile image above the fold decoded, so no screenshot shows a half-loaded gallery. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await expect(galleryRegion(page).getByRole('link').first()).toBeVisible();
  await imagesInViewReady(galleryRegion(page));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** A visible pause in the recorded clip; video timing is the one place where waiting is the point. */
function hold(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

async function newPage(browser: Browser, name: keyof typeof VIEWPORTS, scheme: 'light' | 'dark'): Promise<Page> {
  const mobile = name === 'mobile';
  const context = await browser.newContext({
    viewport: VIEWPORTS[name],
    deviceScaleFactor: mobile ? 2 : 1,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  return context.newPage();
}

test.beforeAll(async () => {
  await mkdir(RAW, { recursive: true });
});

for (const name of ['desktop', 'mobile'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`@media ${name} ${scheme}`, async ({ browser }) => {
      const page = await newPage(browser, name, scheme);
      await page.goto('/');
      await settle(page);
      await page.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
      await page.context().close();
    });
  }
}

test('@media desktop detail dialog', async ({ browser }) => {
  const page = await newPage(browser, 'desktop', 'light');
  await page.goto('/');
  await settle(page);
  await galleryRegion(page).getByRole('link').nth(1).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img').first()).toBeVisible();
  await expect(dialog.getByRole('listitem').first()).toBeVisible();
  await imagesInViewReady(dialog);
  // Scroll the dialog to its comment form and the comments below the image.
  await dialog.evaluate((element) => {
    const scroller = [element, ...element.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 4);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await page.screenshot({ path: path.join(OUT, 'desktop-detail-light.png') });
  await page.context().close();
});

test('@media upload flow clip', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    viewport: VIEWPORTS.desktop,
    colorScheme: 'light',
    recordVideo: { dir: RAW, size: VIEWPORTS.desktop },
  });
  // Set from the 201 until the UI has deleted the image again; `finally` removes it when a step in between fails, so
  // a failed run never leaves a second "Iris, second try" in the demo data (and in the next screenshots).
  let uploadedId: number | undefined;
  try {
    const page = await context.newPage();
    await page.goto('/');
    await settle(page);
    await expect(
      tileLink(page, UPLOAD_TITLE),
      'left over from an earlier run: remove it with `pnpm --filter @app/api admin:remove-image <id> --yes`',
    ).toHaveCount(0);
    await hold(page, 800);

    const toggle = uploadToggle(page);
    await toggle.click();
    const author = page.getByLabel('Name (shown publicly)', { exact: true });
    const form = page.locator('form', { has: author });
    await hold(page, 400);
    await author.pressSequentially('Marit', { delay: 60 });
    await form.getByLabel('Title', { exact: true }).pressSequentially(UPLOAD_TITLE, { delay: 45 });
    await form
      .getByLabel('Description (optional)', { exact: true })
      .pressSequentially('Same iris, one more evening.', { delay: 25 });
    await form.locator('input[type="file"]').setInputFiles(UPLOAD_FILE);
    await hold(page, 900);
    const uploaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === IMAGES_PATH && r.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'upload image', exact: true }).click();
    const response = await uploaded;
    expect(response.status()).toBe(201);
    uploadedId = ((await response.json()) as { id: number }).id;

    const tile = tileLink(page, UPLOAD_TITLE);
    await expect(tile).toBeVisible();
    await hold(page, 700);
    await toggle.click(); // collapse the panel so the new first tile is in view
    await hold(page, 1200);
    await tile.hover();
    await hold(page, 500);
    await tile.click();
    const dialog = detailDialog(page, UPLOAD_TITLE);
    await expect(dialog.getByRole('img', { name: UPLOAD_TITLE, exact: true })).toBeVisible();
    await hold(page, 1500);
    await dialog.getByRole('button', { name: 'delete image', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this image?', exact: true });
    await expect(confirm).toBeVisible();
    await hold(page, 1100);
    await confirm.getByRole('button', { name: 'delete', exact: true }).click();
    await expect(tile).toHaveCount(0);
    uploadedId = undefined;
    await hold(page, 1600);

    const video = page.video();
    await context.close(); // the video file is finalised on close
    await video?.saveAs(path.join(RAW, 'upload-flow.webm'));
    await video?.delete(); // the copy under its generated name
  } finally {
    // The context's own session uploaded the image, so its request context may delete it (F-35).
    if (uploadedId !== undefined && (await getImageViaApi(context.request, uploadedId)) !== null) {
      await deleteImageViaApi(context.request, uploadedId);
    }
    await context.close();
  }
});
