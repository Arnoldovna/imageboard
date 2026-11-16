import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import {
  createCommentViaApi,
  createImageViaApi,
  deleteImageViaApi,
  E2E_AUTHOR,
  type ImageInfo,
  MAX_ID,
  uniqueTitle,
} from './support/api.ts';
import { galleryHeading, galleryRegion, revealTiles, tileLink } from './support/screens.ts';
import { fulfillInternalError } from './support/stubs.ts';

/**
 * Image detail dialog (F-11 to F-16, F-53 to F-55; B-13, B-21, B-48, B-49, B-59, B-60, B-64, B-65, B-69, B-70).
 *
 * Data rules (ADR 0015): every test creates its own images through the API with unique titles; images created with
 * `page.request` belong to the page's session. Other specs upload in parallel, so a tile is located by its exact
 * title (paging with "load more" when newer uploads pushed it off the first page), never by position or count.
 */

const DESCRIPTION = 'A flat-colour test image.\nSecond line of the description.';

/**
 * The current path, after asserting that the URL holds no `#` at all (B-59). `URL#hash` cannot prove that: it is ''
 * for a trailing bare `#` as well.
 */
function pathOf(page: Page): string {
  const url = page.url();
  expect(url, 'no stray "#" in the URL (B-59)').not.toContain('#');
  return new URL(url).pathname;
}

/** The open dialog: the detail of an image or "Image not found". There is at most one (no confirmation here). */
function currentDialog(page: Page): Locator {
  return page.getByRole('dialog');
}

function closeButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: /^close$/i });
}

/** Opens the gallery and returns the tile of `title`, clicking "load more" until it is loaded. */
async function openGalleryAt(page: Page, title: string): Promise<Locator> {
  await page.goto('/');
  await revealTiles(page, [title]);
  return tileLink(page, title);
}

/** Opens the detail of `image` from its gallery tile and waits until its data is shown. */
async function openFromTile(page: Page, image: ImageInfo): Promise<{ tile: Locator; dialog: Locator }> {
  const tile = await openGalleryAt(page, image.title);
  await tile.click();
  const dialog = currentDialog(page);
  await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
  return { tile, dialog };
}

/** Collects every `GET /api/images/:id` request of this page (not the comments sub-resource). */
function trackDetailRequests(page: Page, id: number): Request[] {
  const path = `/api/images/${String(id)}`;
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === path) requests.push(request);
  });
  return requests;
}

/** Waits until two frames have been rendered, so a scroll started by an input event has had time to move. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
}

test.describe('open from the gallery', () => {
  test('F-11: activating a tile opens a modal dialog over the gallery with image, title, description, author and date', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, {
      title: uniqueTitle('Detail F-11'),
      description: DESCRIPTION,
    });

    const { tile, dialog } = await openFromTile(page, image);

    expect(pathOf(page)).toBe(`/images/${String(image.id)}`);
    await expect(dialog).toBeVisible();
    // A modal dialog shown with showModal() matches :modal; an inline <dialog open> would not.
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);

    const picture = dialog.getByRole('img', { name: image.title, exact: true });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute('src', image.url);
    // The original has actually loaded (decoded pixels), not only an element with a src.
    await expect
      .poll(() => picture.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0))
      .toBe(true);
    const description = dialog.getByText('A flat-colour test image.');
    await expect(description).toBeVisible();
    // Plain text with its line break kept by CSS (white-space: pre-line), never rendered as HTML.
    expect(await description.evaluate((element: HTMLElement) => element.innerText)).toBe(DESCRIPTION);
    await expect(dialog.getByText(`Posted by ${E2E_AUTHOR} on`)).toBeVisible();
    await expect(dialog.locator('time')).toHaveAttribute('datetime', image.createdAt);

    // The gallery stays mounted behind the dialog: the tile that opened it is still there.
    await expect(tile).toBeAttached();

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-12, B-59: the dialog has its own URL; Back closes it and returns to "/" with no "#"', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-12 back') });
    const { tile, dialog } = await openFromTile(page, image);
    expect(pathOf(page)).toBe(`/images/${String(image.id)}`);

    await page.goBack();

    await expect(dialog).toBeHidden();
    expect(pathOf(page)).toBe('/');
    await expect(tile).toBeVisible();
    await expect(page).toHaveTitle('Imageboard');

    // Forward opens the same image again: the URL alone is enough to show it.
    await page.goForward();
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    expect(pathOf(page)).toBe(`/images/${String(image.id)}`);

    await expectNoA11yViolations(page);
  });

  test('F-12: the close button after opening from a tile goes back to "/" without adding a history entry', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-12 close') });
    const { dialog } = await openFromTile(page, image);
    const lengthWhileOpen = await page.evaluate(() => history.length);

    await closeButton(dialog).click();

    await expect(dialog).toBeHidden();
    expect(pathOf(page)).toBe('/');
    expect(await page.evaluate(() => history.length)).toBe(lengthWhileOpen);
    await expectNoA11yViolations(page);
  });

  test('F-12: reloading /images/:id shows the dialog over the gallery again', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-12 reload') });
    await openFromTile(page, image);

    await page.reload();

    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    expect(pathOf(page)).toBe(`/images/${String(image.id)}`);
    await expect(page.locator('h2', { hasText: /^Gallery$/ })).toBeAttached();
    await expectNoA11yViolations(page);
  });
});

test.describe('deep link', () => {
  test('F-12, B-59: opening /images/:id directly shows the dialog over the gallery; closing replaces it with "/"', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-12 deep link') });

    await page.goto(`/images/${String(image.id)}`);

    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    await expect(page.locator('h2', { hasText: /^Gallery$/ })).toBeAttached();
    // The gallery behind the dialog has its first page, so whether it holds the tile is settled before the close
    // decides where focus goes; otherwise the page could arrive between that decision and the check below.
    // (A CSS locator: the page behind the modal dialog is inert.)
    await expect(page.locator('[data-image-id]').first()).toBeAttached();
    const lengthWhileOpen = await page.evaluate(() => history.length);

    await closeButton(dialog).click();

    await expect(dialog).toBeHidden();
    expect(pathOf(page)).toBe('/');
    // No previous app entry to go back to: the dialog entry is replaced, not pushed over (ADR 0011).
    expect(await page.evaluate(() => history.length)).toBe(lengthWhileOpen);
    // Focus goes to the image's tile when the gallery has loaded it, else to the "Gallery" heading (ADR 0011). Other
    // specs upload in parallel, so whether the tile is on the first page is not fixed here; both outcomes are checked.
    const tile = tileLink(page, image.title);
    const tileLoaded = (await tile.count()) > 0;
    await expect(tileLoaded ? tile : galleryHeading(page)).toBeFocused();
    await expectNoA11yViolations(page);
  });
});

test.describe('not found', () => {
  test('F-13, B-21, B-13: the API answers 404 problem+json for an unknown id and 400 for an invalid one', async ({
    request,
  }) => {
    const image = await createImageViaApi(request, { title: uniqueTitle('Detail F-13 api') });
    await deleteImageViaApi(request, image.id);

    const unknown = await request.get(`/api/images/${String(image.id)}`);
    expect(unknown.status()).toBe(404);
    expect(unknown.headers()['content-type']).toMatch(/^application\/problem\+json/);
    expect(await unknown.json()).toMatchObject({ status: 404 });

    for (const invalid of ['abc', '0', '-1', '1.5', String(MAX_ID + 1)]) {
      const response = await request.get(`/api/images/${invalid}`);
      expect(response.status(), invalid).toBe(400);
      expect(response.headers()['content-type'], invalid).toMatch(/^application\/problem\+json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body, invalid).toMatchObject({ status: 400 });
      // Never a driver message (B-13: invalid input never reaches Postgres).
      expect(JSON.stringify(body), invalid).not.toMatch(/22P02|22003|invalid input syntax|out of range for type/i);
    }
  });

  test('F-13, B-49, F-55: an unknown id shows "Image not found" with a link back to the gallery', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-13 deleted') });
    await deleteImageViaApi(page.request, image.id);
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto(`/images/${String(image.id)}`);

    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: 'Image not found', exact: true })).toBeVisible();
    await expect(dialog).toHaveAccessibleName('Image not found');
    await expect(dialog.getByText('This image does not exist or has been deleted.')).toBeVisible();
    await expect(page).toHaveTitle('Image not found · Imageboard');
    await expectNoA11yViolations(page);

    const back = dialog.getByRole('link', { name: 'back to the gallery', exact: true });
    await expect(back).toHaveAttribute('href', '/');
    // F-55: the link is named by its text; the arrow is decorative and hidden from assistive technology.
    await expect(back.locator('[aria-hidden="true"]')).toHaveText('←');
    await back.click();

    await expect(dialog).toBeHidden();
    expect(pathOf(page)).toBe('/');
    await expect(page).toHaveTitle('Imageboard');
    // The image has no tile (it was deleted), so focus continues at the "Gallery" heading (ADR 0011).
    await expect(galleryHeading(page)).toBeFocused();
    expect(pageErrors, 'no render error (B-49)').toEqual([]);
    await expectNoA11yViolations(page);
  });

  test('F-13: an id outside the integer range shows "Image not found", not an error', async ({ page }) => {
    await page.goto(`/images/${String(MAX_ID + 1)}`);

    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: 'Image not found', exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('B-59: a non-numeric image path is the catch-all 404 page, not a dialog', async ({ page }) => {
    await page.goto('/images/abc');

    await expect(page.getByRole('heading', { level: 2, name: 'Page not found', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveTitle('Page not found · Imageboard');
    await expectNoA11yViolations(page);
  });
});

test.describe('dates', () => {
  // Fixed zone without daylight saving and with a 45-minute offset, so a time printed in UTC or in the machine's
  // zone cannot pass by accident.
  const TIME_ZONE = 'Asia/Kathmandu';
  const OFFSET_MINUTES = 5 * 60 + 45;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

  test.use({ timezoneId: TIME_ZONE });

  /** Expected maw format in the viewer's zone, computed by plain offset arithmetic (independent of Intl). */
  function inViewerZone(iso: string): { date: string; dateTime: string } {
    const shifted = new Date(Date.parse(iso) + OFFSET_MINUTES * 60_000);
    const date = `${String(shifted.getUTCDate())} ${MONTHS[shifted.getUTCMonth()] ?? '?'} ${String(shifted.getUTCFullYear())}`;
    const time = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
    return { date, dateTime: `${date}, ${time}` };
  }

  test('F-14, B-60: dates are <time datetime="<ISO>"> in a readable en format in the viewer\'s time zone', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-14') });
    const expected = inViewerZone(image.createdAt);

    const tile = await openGalleryAt(page, image.title);
    // The date is in the tile's meta, beside the link (the link itself holds only the preview and the title).
    const tileTime = galleryRegion(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: image.title, exact: true }) })
      .locator('time');
    await expect(tileTime).toHaveAttribute('datetime', image.createdAt);
    await expect(tileTime).toHaveText(expected.date);

    await tile.click();
    const dialog = currentDialog(page);
    const time = dialog.locator('time');
    await expect(time).toHaveAttribute('datetime', image.createdAt);
    await expect(time).toHaveText(expected.dateTime);
    // Never a raw ISO timestamp as visible text.
    await expect(dialog).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await expectNoA11yViolations(page);
  });
});

test.describe('dialog accessibility', () => {
  test('F-15, B-69: labelled modal dialog; focus moves to "close", Tab stays inside, Esc closes and focus returns to the tile', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-15 focus') });
    const { tile, dialog } = await openFromTile(page, image);

    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAccessibleName(image.title);
    const heading = dialog.getByRole('heading', { level: 2, name: image.title, exact: true });
    const labelledBy = await dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    await expect(heading).toHaveAttribute('id', labelledBy!);

    const close = closeButton(dialog);
    expect(await close.evaluate((element) => element.tagName)).toBe('BUTTON');
    await expect(close).toBeFocused();

    // Tab and Shift+Tab never reach the page behind, and the sequence wraps around inside the dialog: within a few
    // presses focus returns to a stop it already visited. A native modal dialog may hand focus to the browser's own
    // UI between the last and the first stop (HTML focus navigation, APG dialog pattern); then the document itself
    // has no focus. Which controls are stops depends on the engine (WebKit, like Safari by default, tabs only to text
    // fields), so the check is the wrap-around, not a fixed list. Any focused element of the page is a failure.
    for (const key of ['Tab', 'Shift+Tab'] as const) {
      await close.focus();
      const visited = await page.evaluateHandle(() => new Set<Element>());
      let wrapped = false;
      for (let step = 1; step <= 12 && !wrapped; step += 1) {
        await page.keyboard.press(key);
        const where = await page.evaluate((seen) => {
          const active = document.activeElement;
          const open = document.querySelector('dialog[open]');
          const inside = open !== null && active !== null && open.contains(active);
          const repeated = inside && seen.has(active);
          if (inside) seen.add(active);
          return {
            inside,
            repeated,
            inBrowserUi: !document.hasFocus() && (active === null || active === document.body),
            label: active === null ? 'null' : `${active.tagName} ${active.textContent.trim().slice(0, 40)}`,
          };
        }, visited);
        expect(where.inside || where.inBrowserUi, `${key} #${String(step)} focused ${where.label}`).toBe(true);
        wrapped = where.repeated;
      }
      await visited.dispose();
      expect(wrapped, `${key} wraps around inside the dialog`).toBe(true);
    }

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    expect(pathOf(page)).toBe('/');
    await expect(tile).toBeFocused();
    await expectNoA11yViolations(page);
  });

  test('F-15: the close button returns focus to the tile that opened the dialog', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-15 close') });
    const { tile, dialog } = await openFromTile(page, image);

    await closeButton(dialog).click();

    await expect(dialog).toBeHidden();
    await expect(tile).toBeFocused();
    await expectNoA11yViolations(page);
  });

  test('F-15, B-69: the page behind the open dialog does not scroll', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-15 scroll') });
    const tile = await openGalleryAt(page, image.title);
    // Make sure the page is taller than the viewport whatever the gallery holds right now. CSSOM writes are allowed
    // by the CSP (only inline style attributes and elements are not).
    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (main !== null) main.style.minBlockSize = '300vh';
    });
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    await tile.click();
    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('hidden');
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    // The left page gutter is backdrop on every width; the wheel there would scroll the document.
    const backdrop = { x: 4, y: Math.round((viewport?.height ?? 0) / 2) };
    await page.mouse.move(backdrop.x, backdrop.y);
    const lockedAt = await scrollTop(page);
    await page.mouse.wheel(0, 600);
    await nextFrames(page);
    expect(await scrollTop(page), 'the document did not scroll while the dialog was open').toBe(lockedAt);

    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
    // Control: the same wheel scrolls the page once the dialog is closed.
    await page.mouse.move(backdrop.x, backdrop.y);
    const before = await scrollTop(page);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(before);
    await expectNoA11yViolations(page);
  });
});

test.describe('loading', () => {
  test('F-16, B-48: a loading state shows while the detail loads, and the detail is fetched once per open', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-16 once') });
    const requests = trackDetailRequests(page, image.id);
    const tile = await openGalleryAt(page, image.title);

    // Hold the detail response until the loading state has been seen.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detailPath = `/api/images/${String(image.id)}`;
    await page.route(
      (url) => url.pathname === detailPath,
      async (route) => {
        await released;
        await route.continue();
      },
    );

    await tile.click();
    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: 'Loading image…', exact: true })).toBeVisible();
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/images/${String(image.id)}$`));
    release();

    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
    // Comments have loaded too, so any follow-up request of this open would have been sent by now.
    await expect(dialog.getByText('No comments yet. Start the conversation.')).toBeVisible();
    expect(requests).toHaveLength(1);

    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect(requests).toHaveLength(1);

    await tile.click();
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    await expect(dialog.getByText('No comments yet. Start the conversation.')).toBeVisible();
    expect(requests, 'one request per open').toHaveLength(2);
    await expectNoA11yViolations(page);
  });

  test("F-16: opening image B after image A never shows A's data under B's URL", async ({ page }) => {
    const prefix = uniqueTitle('Detail F-16 switch');
    const first = await createImageViaApi(page.request, { title: `${prefix} A`, description: 'Description of A.' });
    const second = await createImageViaApi(page.request, { title: `${prefix} B`, description: 'Description of B.' });

    const { dialog } = await openFromTile(page, first);
    await expect(dialog.getByText('Description of A.')).toBeVisible();
    await closeButton(dialog).click();
    await expect(dialog).toBeHidden();

    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const secondPath = `/api/images/${String(second.id)}`;
    await page.route(
      (url) => url.pathname === secondPath,
      async (route) => {
        await released;
        await route.continue();
      },
    );

    const secondTile = await openGalleryAt(page, second.title);
    await secondTile.click();
    await expect(page).toHaveURL(new RegExp(`/images/${String(second.id)}$`));
    await expect(dialog.getByRole('heading', { level: 2, name: 'Loading image…', exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(first.title);
    await expect(dialog).not.toContainText('Description of A.');
    await expect(dialog.getByRole('img')).toHaveCount(0);
    release();

    await expect(dialog.getByRole('heading', { level: 2, name: second.title, exact: true })).toBeVisible();
    await expect(dialog.getByText('Description of B.')).toBeVisible();
    await expect(dialog).not.toContainText('Description of A.');
    await expectNoA11yViolations(page);
  });

  test('B-49: a failed load shows an error with "try again" instead of crashing, and the retry loads the image', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail B-49 error') });
    const detailPath = `/api/images/${String(image.id)}`;
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    const isDetail = (url: URL): boolean => url.pathname === detailPath;
    await page.route(isDetail, fulfillInternalError);

    await page.goto(`/images/${String(image.id)}`);

    const dialog = currentDialog(page);
    await expect(
      dialog.getByRole('heading', { level: 2, name: 'Image could not be loaded', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expectNoA11yViolations(page);

    await page.unroute(isDetail, fulfillInternalError);
    await dialog.getByRole('button', { name: 'try again', exact: true }).click();

    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    await expectNoA11yViolations(page);
  });
});

test.describe('document and outline', () => {
  test('F-53, B-64: lang, charset and viewport are set, and the document title follows the route', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-53') });

    const tile = await openGalleryAt(page, image.title);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('meta[charset]')).toHaveAttribute('charset', /^utf-8$/i);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);
    await expect(page).toHaveTitle('Imageboard');

    await tile.click();
    await expect(page).toHaveTitle(`${image.title} · Imageboard`);

    await page.keyboard.press('Escape');
    await expect(page).toHaveTitle('Imageboard');
    await expectNoA11yViolations(page);
  });

  test('F-54, B-70: one h1, "Upload an image" and "Gallery" as h2, the image title as the dialog h2, "Comments" as h3', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-54') });
    const commentBody = `Comment body ${uniqueTitle('outline')}`;
    await createCommentViaApi(page.request, image.id, { body: commentBody });

    const tile = await openGalleryAt(page, image.title);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'imageboard', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Upload an image', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Gallery', exact: true })).toBeVisible();

    await tile.click();
    const dialog = currentDialog(page);
    await expect(dialog.getByRole('heading', { level: 2, name: image.title, exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 3, name: 'Comments', exact: true })).toBeVisible();
    await expect(dialog.getByText(commentBody)).toBeVisible();
    // The dialog's outline is exactly title (h2) → "Comments" (h3); comment bodies are never headings.
    const outline = await dialog.evaluate((element) =>
      [...element.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
        (heading) => `${heading.tagName} ${heading.textContent.trim()}`,
      ),
    );
    expect(outline).toEqual([`H2 ${image.title}`, 'H3 Comments']);
    await expect(page.locator('h1')).toHaveCount(1);
    await expectNoA11yViolations(page);
  });

  test('F-55, B-65: the dialog image uses the title as alt; the tile image is alt="" inside a link named by the title', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Detail F-55') });

    const tile = await openGalleryAt(page, image.title);
    await expect(tile).toHaveAccessibleName(image.title);
    await expect(tile.locator('img')).toHaveAttribute('alt', '');

    await tile.click();
    const dialog = currentDialog(page);
    const picture = dialog.getByRole('img', { name: image.title, exact: true });
    await expect(picture).toHaveAttribute('alt', image.title);
    // Every image in the dialog has a text alternative attribute; every control has a name.
    expect(await dialog.locator('img:not([alt])').count()).toBe(0);
    for (const button of await dialog.getByRole('button').all()) {
      expect((await button.textContent())?.trim(), 'button has a visible name').not.toBe('');
    }
    await expectNoA11yViolations(page);
  });
});
