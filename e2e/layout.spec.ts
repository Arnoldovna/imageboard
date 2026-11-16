import { expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import { createImageViaApi, createImagesViaApi, type ImageInfo, uniqueTitle } from './support/api.ts';
import { imageFixture, type ImageFixtureName } from './support/files.ts';
import { galleryRegion, revealTiles, tileLink, uploadToggle } from './support/screens.ts';

/**
 * Layout journeys (BUILD-ORDER phase 5, OVERVIEW §15): image attributes and layout stability (F-09), the responsive
 * grid without horizontal scroll (F-10, B-75), the one-row sticky upload bar (F-57, B-58), footer links (F-58, B-73),
 * the header wordmark (F-59) and reduced motion (F-60, B-76).
 *
 * Data rules (ADR 0015): every test creates its own images through the API with unique titles and finds them by
 * their exact title. Other workers upload at the same time, so nothing here depends on counts or on which images
 * happen to be first; `revealTiles` pages through "load more" until the test's own tiles are shown.
 */

/** Widths from F-10 / ADR 0015: phone, the mobile project, tablet, small laptop, the desktop project, full HD. */
const WIDTHS = [320, 390, 768, 1024, 1440, 1920] as const;

/** `--breakpoint-sm` (40rem): from here the site header is pinned as well (SiteHeader.css). */
const SM_BREAKPOINT = 640;

/** F-57 / OVERVIEW §15: the pinned upload bar is a compact row, at most 4rem high. */
const MAX_BAR_BLOCK_SIZE = 64;

/** F-09: cumulative layout shift budget ("good" threshold of Core Web Vitals). */
const CLS_BUDGET = 0.1;

/** F-09: tiles at these indexes form the first row on the widest grid and load eagerly; every later tile is lazy. */
const EAGER_TILES = 4;

/** Sub-pixel tolerance for comparisons of layout positions. */
const EPSILON = 1;

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** The region the disclosure button controls (`aria-controls`), i.e. the upload form's container. */
async function uploadRegion(page: Page): Promise<Locator> {
  const id = await uploadToggle(page).getAttribute('aria-controls');
  expect(id, 'the upload disclosure names the region it controls').toBeTruthy();
  return page.locator(`[id="${id ?? ''}"]`);
}

/** Fails with the widest offending elements when the page (or an open dialog) scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const viewport = root.clientWidth;
    const dialog = document.querySelector('dialog[open]');
    const offenders = [...document.body.querySelectorAll('*')]
      .map((element) => ({ element, right: element.getBoundingClientRect().right }))
      .filter(({ right }) => right > viewport + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5)
      .map(({ element, right }) => `${element.tagName.toLowerCase()}.${element.className} right=${String(right)}`);
    return {
      viewport,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      dialog:
        dialog === null
          ? null
          : {
              scrollWidth: dialog.scrollWidth,
              clientWidth: dialog.clientWidth,
              left: dialog.getBoundingClientRect().left,
              right: dialog.getBoundingClientRect().right,
            },
      offenders,
    };
  });
  const details = `${where}: ${JSON.stringify(report)}`;
  expect(report.rootScrollWidth, details).toBeLessThanOrEqual(report.viewport);
  expect(report.bodyScrollWidth, details).toBeLessThanOrEqual(report.viewport);
  if (report.dialog !== null) {
    expect(report.dialog.scrollWidth, details).toBeLessThanOrEqual(report.dialog.clientWidth);
    expect(report.dialog.left, details).toBeGreaterThanOrEqual(0);
    expect(report.dialog.right, details).toBeLessThanOrEqual(report.viewport);
  }
}

/** Number of grid columns as laid out: distinct horizontal positions of the gallery's list items. */
async function galleryColumns(page: Page): Promise<number> {
  const lefts = await galleryRegion(page)
    .getByRole('listitem')
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().left)));
  return new Set(lefts).size;
}

function scrollTo(page: Page, top: number): Promise<void> {
  // `instant` overrides the root's `scroll-behavior: smooth`, so the position is final when evaluate returns.
  return page.evaluate((y) => {
    window.scrollTo({ top: y, behavior: 'instant' });
  }, top);
}

/** Position of an element's top edge in the document (independent of the scroll position). */
function documentTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
}

interface LayoutShiftRecord {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
}

interface LayoutShiftWindow {
  layoutShifts?: LayoutShiftRecord[];
  layoutShiftSupported?: boolean;
}

/**
 * Records every `layout-shift` entry from the very start of each document (before any app script runs), so the
 * skeleton → tiles swap and font loading are measured too.
 */
async function recordLayoutShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as Window & LayoutShiftWindow;
    const shifts: LayoutShiftRecord[] = [];
    target.layoutShifts = shifts;
    target.layoutShiftSupported = PerformanceObserver.supportedEntryTypes.includes('layout-shift');
    if (!target.layoutShiftSupported) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // LayoutShift is not part of lib.dom yet; these are its spec'd fields.
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        shifts.push({ value: shift.value, startTime: shift.startTime, hadRecentInput: shift.hadRecentInput });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

/**
 * CLS as Core Web Vitals defines it: the largest session window (shifts less than 1 s apart, window at most 5 s) of
 * shifts without recent input. The plain sum of all shifts is returned for the failure message.
 */
async function readCumulativeLayoutShift(page: Page): Promise<{ cls: number; sum: number; count: number }> {
  const { supported, shifts } = await page.evaluate(() => {
    const source = window as Window & LayoutShiftWindow;
    return { supported: source.layoutShiftSupported ?? false, shifts: source.layoutShifts ?? [] };
  });
  expect(supported, 'the browser reports layout-shift entries').toBe(true);

  let cls = 0;
  let current = 0;
  let windowStart = 0;
  let previous = 0;
  let sum = 0;
  const counted = shifts.filter((shift) => !shift.hadRecentInput);
  for (const shift of counted) {
    sum += shift.value;
    if (current > 0 && shift.startTime - previous < 1000 && shift.startTime - windowStart < 5000) {
      current += shift.value;
    } else {
      current = shift.value;
      windowStart = shift.startTime;
    }
    previous = shift.startTime;
    cls = Math.max(cls, current);
  }
  return { cls, sum, count: counted.length };
}

/** Uploads one image per fixture name, oldest first, each titled `<prefix> <index>`. */
async function createImagesWithFixtures(
  page: Page,
  prefix: string,
  fixtures: readonly ImageFixtureName[],
): Promise<ImageInfo[]> {
  const images: ImageInfo[] = [];
  for (const [index, name] of fixtures.entries()) {
    // Sequential: the creation order is the gallery order (F-04).
    images.push(
      await createImageViaApi(page.request, {
        title: `${prefix} ${String(index + 1)}`,
        file: imageFixture(name),
      }),
    );
  }
  return images;
}

interface MotionReport {
  /** Elements with a running or filling CSS animation or transition (`document.getAnimations()`). */
  animations: string[];
  /** Elements whose computed style declares an animation or a non-zero transition. */
  declared: string[];
  /** Elements with a `transform`, `scale` or `rotate` (legacy hover zoom, B-76). */
  transformed: string[];
  scrollBehavior: string;
}

/** Everything that moves or could move in the current state of the document, described for failure messages. */
function readMotion(page: Page): Promise<MotionReport> {
  return page.evaluate(() => {
    const describe = (element: Element | null): string =>
      element === null ? '(none)' : `${element.tagName.toLowerCase()}.${element.className}`;
    const isZero = (durations: string): boolean => durations.split(',').every((value) => parseFloat(value) === 0);

    const animations = document.getAnimations().map((animation) => {
      const effect = animation.effect;
      const element = effect instanceof KeyframeEffect ? effect.target : null;
      const name =
        animation instanceof CSSAnimation
          ? animation.animationName
          : animation instanceof CSSTransition
            ? `transition ${animation.transitionProperty}`
            : 'script animation';
      return `${name} on ${describe(element)}`;
    });

    const declared: string[] = [];
    const transformed: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (style.animationName !== 'none') declared.push(`animation ${style.animationName} on ${describe(element)}`);
      if (!isZero(style.transitionDuration) || !isZero(style.transitionDelay)) {
        declared.push(`transition ${style.transitionProperty} on ${describe(element)}`);
      }
      if (style.transform !== 'none' || style.scale !== 'none' || style.rotate !== 'none') {
        transformed.push(describe(element));
      }
    }
    return {
      animations,
      declared,
      transformed,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// F-09: image attributes and layout stability
// ---------------------------------------------------------------------------------------------------------------

test.describe('gallery images and layout stability', () => {
  test('F-09: tile images carry the stored width/height, decode async and load lazily after the first row', async ({
    page,
  }) => {
    const prefix = uniqueTitle('F-09 attributes');
    // Three different aspect ratios prove the attributes come from each image's stored dimensions; five tiles make
    // sure at least one lazy tile exists.
    const images = await createImagesWithFixtures(page, prefix, [
      'landscapeJpeg',
      'portraitPng',
      'squareGif',
      'landscapeJpeg',
      'portraitPng',
    ]);

    await page.goto('/');
    await revealTiles(
      page,
      images.map((image) => image.title),
    );

    for (const image of images) {
      // alt="" (F-55): the preview is presentational, so it is found as an element, not by the img role.
      const img = tileLink(page, image.title).locator('img');
      await expect(img).toHaveAttribute('width', String(image.width));
      await expect(img).toHaveAttribute('height', String(image.height));
      await expect(img).toHaveAttribute('decoding', 'async');
      await expect(img).toHaveAttribute('src', image.previewUrl);
    }
    // The fixtures' real pixel sizes reached the DOM unchanged (landscape 120×80, portrait 60×90, square 40×40).
    expect(images.map((image) => [image.width, image.height])).toEqual([
      [120, 80],
      [60, 90],
      [40, 40],
      [120, 80],
      [60, 90],
    ]);

    // Every tile on the page, whatever other workers uploaded: positive integer dimensions, async decoding, eager
    // only in the first row (four tiles on the widest grid), lazy afterwards.
    const tiles = await galleryRegion(page)
      .getByRole('listitem')
      .evaluateAll((items) =>
        items.map((item) => {
          const img = item.querySelector('img');
          return {
            width: img?.getAttribute('width') ?? null,
            height: img?.getAttribute('height') ?? null,
            loading: img?.getAttribute('loading') ?? null,
            decoding: img?.getAttribute('decoding') ?? null,
          };
        }),
      );
    expect(tiles.length).toBeGreaterThan(EAGER_TILES);
    for (const [index, attributes] of tiles.entries()) {
      const where = `tile ${String(index)}: ${JSON.stringify(attributes)}`;
      expect(attributes.width, where).toMatch(/^[1-9]\d*$/);
      expect(attributes.height, where).toMatch(/^[1-9]\d*$/);
      expect(attributes.decoding, where).toBe('async');
      expect(attributes.loading, where).toBe(index < EAGER_TILES ? 'eager' : 'lazy');
    }

    await expectNoA11yViolations(page);
  });

  test('F-09: the gallery stays stable (CLS < 0.1) through first load, "load more" and lazy images', async ({
    page,
  }) => {
    const prefix = uniqueTitle('F-09 stability');
    // 13 images (one more than a page, F-02), mixed aspect ratios: at least one "load more" is needed.
    const fixtures: ImageFixtureName[] = ['landscapeJpeg', 'portraitPng', 'squareGif'];
    const images = await createImagesWithFixtures(
      page,
      prefix,
      Array.from({ length: 13 }, (_, index) => fixtures[index % fixtures.length] ?? 'landscapeJpeg'),
    );
    const titles = images.map((image) => image.title);
    await recordLayoutShifts(page);

    await page.goto('/');
    await revealTiles(page, titles);

    // Scroll every tile into view, so each lazy image loads into the space its frame reserved, and wait until it has
    // decoded: a missing reservation would shift the rows below it now.
    for (const title of titles) {
      const link = tileLink(page, title);
      await link.scrollIntoViewIfNeeded();
      const img = link.locator('img');
      await expect(img).toHaveJSProperty('complete', true);
      expect(await img.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const { cls, sum, count } = await readCumulativeLayoutShift(page);
    const measured = `${cls.toFixed(4)} (sum ${sum.toFixed(4)} over ${String(count)} shifts)`;
    test.info().annotations.push({ type: 'CLS', description: measured });
    expect(cls, `CLS ${measured}`).toBeLessThan(CLS_BUDGET);

    await expectNoA11yViolations(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F-10, B-75: responsive grid, no horizontal scroll
// ---------------------------------------------------------------------------------------------------------------

test.describe('responsive layout', () => {
  test('F-10: the grid goes from 1 column at 320 px to 4 on wide screens', async ({ page }) => {
    const prefix = uniqueTitle('F-10 columns');
    const images = await createImagesViaApi(page.request, 4, prefix);

    await page.goto('/');
    await revealTiles(
      page,
      images.map((image) => image.title),
    );

    const columns: number[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const count = await galleryColumns(page);
      expect(count, `columns at ${String(width)} px`).toBeGreaterThanOrEqual(1);
      expect(count, `columns at ${String(width)} px`).toBeLessThanOrEqual(4);
      columns.push(count);
    }

    const at = (width: (typeof WIDTHS)[number]): number | undefined => columns[WIDTHS.indexOf(width)];
    expect(at(320), 'one column at 320 px').toBe(1);
    expect(at(390), 'one column on a phone').toBe(1);
    expect(at(1440), 'four columns at 1440 px').toBe(4);
    expect(at(1920), 'four columns at 1920 px').toBe(4);
    // Mobile first: widening the viewport never removes a column.
    expect(columns, `columns per width ${JSON.stringify(columns)}`).toEqual([...columns].sort((a, b) => a - b));

    await expectNoA11yViolations(page);
  });

  test('F-10, B-75: no horizontal page scroll between 320 and 1920 px (gallery, open form, dialog, 404)', async ({
    page,
  }) => {
    // Long unbroken words are the classic cause of sideways scroll (legacy fixed widths, B-75).
    const longTitle = uniqueTitle(`Unbroken${'W'.repeat(90)}`);
    const image = await createImageViaApi(page.request, {
      title: longTitle,
      authorName: `Author${'Q'.repeat(54)}`,
      description: `Description${'M'.repeat(300)}`,
      file: imageFixture('portraitPng'),
    });

    await page.goto('/');
    await revealTiles(page, [image.title]);
    await uploadToggle(page).click();
    await expect(await uploadRegion(page)).toBeVisible();

    for (const width of WIDTHS) {
      await test.step(`gallery with the upload form open at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await expect(tileLink(page, image.title)).toBeVisible();
        await expectNoHorizontalOverflow(page, `home ${String(width)} px`);
        // The long title wraps inside its tile: the tile lies within the viewport, it is not merely clipped.
        const box = await tileLink(page, image.title).boundingBox();
        const visibleWidth = await page.evaluate(() => document.documentElement.clientWidth);
        expect(box, `long-title tile at ${String(width)} px`).not.toBeNull();
        expect(box!.x, `long-title tile starts inside the viewport at ${String(width)} px`).toBeGreaterThanOrEqual(0);
        expect(
          box!.x + box!.width,
          `long-title tile ends inside the viewport at ${String(width)} px`,
        ).toBeLessThanOrEqual(visibleWidth);
      });
    }

    await tileLink(page, image.title).click();
    const dialog = page.getByRole('dialog', { name: image.title });
    await expect(dialog).toBeVisible();
    for (const width of WIDTHS) {
      await test.step(`detail dialog at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await expect(dialog).toBeVisible();
        await expectNoHorizontalOverflow(page, `dialog ${String(width)} px`);
      });
    }

    await page.goto(`/does-not-exist-${uniqueTitle('path').replaceAll(' ', '-')}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Page not found' })).toBeVisible();
    for (const width of WIDTHS) {
      await test.step(`not-found page at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(page, `404 ${String(width)} px`);
      });
    }

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/');
    await revealTiles(page, [image.title]);
    await expectNoHorizontalOverflow(page, 'home 320 px');
    await expectNoA11yViolationsInBothColorSchemes(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F-57, B-58: the sticky upload bar
// ---------------------------------------------------------------------------------------------------------------

interface PinnedReport {
  /** Every element with `position: sticky` or `fixed`, classified in document order. */
  pinned: string[];
  /** Border-box height of the nearest pinned ancestor of the disclosure button. */
  barBlockSize: number | null;
}

/** Classifies every pinned element of the document: the site header, the upload bar, or anything else. */
function readPinned(page: Page): Promise<PinnedReport> {
  return uploadToggle(page).evaluate((toggle) => {
    const isPinned = (element: Element): boolean => ['sticky', 'fixed'].includes(getComputedStyle(element).position);
    let bar: Element | null = toggle;
    while (bar !== null && !isPinned(bar)) bar = bar.parentElement;

    const pinned = [...document.querySelectorAll('*')].filter(isPinned).map((element) => {
      if (element === bar) return 'upload bar';
      if (element.tagName === 'HEADER' && element.closest('main, dialog, section, article') === null) {
        return 'site header';
      }
      return `other: ${element.tagName.toLowerCase()}.${element.className}`;
    });
    return { pinned, barBlockSize: bar === null ? null : bar.getBoundingClientRect().height };
  });
}

/**
 * Event types of every listener registered on `window`, and on `document` or any node below it (including `on<type>`
 * handlers), as `window:<type>` / `document:<type>`. Read through the DevTools protocol, so nothing in the page has
 * to be patched; both projects that run this spec are Chromium.
 */
async function registeredListenerTypes(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const found: string[] = [];
    for (const expression of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression });
      expect(result.objectId, `${expression} has a remote object`).toBeDefined();
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId ?? '',
        depth: -1,
        pierce: true,
      });
      found.push(...listeners.map((listener) => `${expression}:${listener.type}`));
    }
    return found;
  } finally {
    await cdp.detach();
  }
}

test.describe('sticky upload bar', () => {
  test('F-57, B-58: only the one-row bar is pinned (CSS sticky, no scroll handler); the form opens below it in normal flow', async ({
    page,
  }) => {
    const prefix = uniqueTitle('F-57 sticky');
    const images = await createImagesViaApi(page.request, 12, prefix);
    const newest = images.at(-1)?.title ?? '';

    for (const width of [390, 768, 1440] as const) {
      await test.step(`at ${String(width)} px`, async () => {
        await page.setViewportSize({ width, height: 640 });
        await page.goto('/');
        await revealTiles(page, [newest]);

        const toggle = uploadToggle(page);
        const region = await uploadRegion(page);
        const header = page.getByRole('banner');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(region).toBeHidden();

        // Only the bar is pinned; from sm up the site header sits above it (SiteHeader.css), below sm it scrolls away.
        const { pinned, barBlockSize } = await readPinned(page);
        expect(pinned).toEqual(width < SM_BREAKPOINT ? ['upload bar'] : ['site header', 'upload bar']);
        expect(barBlockSize, 'the bar is one compact row (≤ 4rem)').not.toBeNull();
        expect(barBlockSize ?? Infinity).toBeLessThanOrEqual(MAX_BAR_BLOCK_SIZE);

        // Disclosure: the form opens below the bar, outside it and in normal flow (no pinned ancestor).
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(region).toBeVisible();
        await expect(region.getByLabel('Name (shown publicly)')).toBeFocused();
        const pinnedAncestor = await region.evaluate((element) => {
          for (let node: Element | null = element; node !== null; node = node.parentElement) {
            if (['sticky', 'fixed'].includes(getComputedStyle(node).position)) return node.tagName;
          }
          return null;
        });
        expect(pinnedAncestor, 'the form is in normal page flow').toBeNull();
        const afterOpen = await readPinned(page);
        expect(afterOpen.pinned).toEqual(pinned);
        expect(afterOpen.barBlockSize ?? Infinity, 'opening the form does not grow the bar').toBeLessThanOrEqual(
          MAX_BAR_BLOCK_SIZE,
        );

        const bar = page
          .locator('*')
          .filter({ has: page.getByRole('heading', { name: 'Upload an image' }) })
          .last();
        const barBox = await bar.boundingBox();
        const regionBox = await region.boundingBox();
        expect(barBox).not.toBeNull();
        expect(regionBox).not.toBeNull();
        expect(regionBox?.y ?? 0, 'the form starts below the bar').toBeGreaterThanOrEqual(
          (barBox?.y ?? 0) + (barBox?.height ?? 0) - EPSILON,
        );

        // Scroll to the end of the page: the bar stays in view, pinned at the top (below the header from sm up),
        // while the form scrolls away with the page.
        const newestTile = tileLink(page, newest);
        const tileTopBefore = await documentTop(newestTile);
        const barTopBefore = await documentTop(bar);
        await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
        const scrollY = await page.evaluate(() => window.scrollY);
        expect(scrollY, 'the page scrolled past the bar').toBeGreaterThan(barTopBefore);

        await expect(bar).toBeInViewport();
        await expect(toggle).toBeInViewport();
        await expect(region).not.toBeInViewport();
        const pinnedTop = (await bar.boundingBox())?.y ?? Number.NaN;
        if (width < SM_BREAKPOINT) {
          await expect(header).not.toBeInViewport();
          expect(pinnedTop).toBeCloseTo(0, 0);
        } else {
          await expect(header).toBeInViewport();
          const headerBox = await header.boundingBox();
          expect(headerBox?.y ?? Number.NaN).toBeCloseTo(0, 0);
          expect(Math.abs(pinnedTop - ((headerBox?.y ?? 0) + (headerBox?.height ?? 0)))).toBeLessThanOrEqual(EPSILON);
        }

        // B-58: sticky keeps the bar's space in the flow, so nothing below it jumped (position: fixed would have).
        expect(Math.abs((await documentTop(newestTile)) - tileTopBefore), 'gallery did not jump').toBeLessThanOrEqual(
          EPSILON,
        );

        // The pinned toggle still works far down the page.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(region).toBeHidden();
        await expect(bar).toBeInViewport();

        // B-58: pinning is pure CSS. No scroll listener exists anywhere (the legacy bar replaced window.onscroll).
        // The router's popstate listener shows that the query does see the app's listeners.
        const listenerTypes = await registeredListenerTypes(page);
        expect(listenerTypes).toContain('window:popstate');
        expect(listenerTypes.filter((type) => type.endsWith(':scroll'))).toEqual([]);
      });
    }

    await expectNoA11yViolations(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F-58, F-59, B-73: header and footer
// ---------------------------------------------------------------------------------------------------------------

test.describe('header and footer', () => {
  test('F-59: the header shows the app name as the only h1, with the legacy tagline', async ({ page }) => {
    await page.goto('/');

    const banner = page.getByRole('banner');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const wordmark = banner.getByRole('heading', { level: 1, name: 'imageboard' });
    await expect(wordmark).toBeVisible();
    await expect(wordmark.getByRole('link', { name: 'imageboard' })).toHaveAttribute('href', '/');
    await expect(banner.getByText('form/vue', { exact: true })).toBeVisible();

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-58, B-73: the footer links to GitHub and LinkedIn by name, safely, without unlabelled icons', async ({
    page,
  }) => {
    await page.goto('/');

    const footer = page.getByRole('contentinfo');
    await expect(footer).toBeVisible();
    for (const name of ['GitHub', 'LinkedIn'] as const) {
      const link = footer.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveText(name);

      const { href, target, rel } = await link.evaluate((element: HTMLAnchorElement) => ({
        href: element.href,
        target: element.target,
        rel: element.rel,
      }));
      expect(new URL(href).protocol, `${name} link is an absolute https URL`).toBe('https:');
      // The URLs themselves are Marina's to confirm (FEATURES §14 R-09); a new tab must not get `window.opener`.
      if (target === '_blank') {
        expect(rel.split(/\s+/), `${name} link opens a new tab`).toContain('noopener');
      }
    }

    // B-73: the GitHub link goes to a profile (one path segment), not to a bootcamp repository.
    const github = new URL(
      (await footer.getByRole('link', { name: 'GitHub', exact: true }).getAttribute('href')) ?? 'about:blank',
    );
    expect(github.hostname).toBe('github.com');
    expect(github.pathname.split('/').filter(Boolean)).toHaveLength(1);

    // B-73: no vague icon links; any icon would have to be decorative and hidden from assistive technology.
    await expect(footer.locator('img:not([alt=""]), svg:not([aria-hidden="true"])')).toHaveCount(0);

    await expectNoA11yViolations(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F-60, B-76: reduced motion
// ---------------------------------------------------------------------------------------------------------------

/** Hover targets that animate for pointer users: a tile title, the wordmark, a footer link and the upload toggle. */
async function hoverMotionTargets(page: Page, title: string, onEach: (what: string) => Promise<void>): Promise<void> {
  const targets: [string, Locator][] = [
    ['tile', tileLink(page, title)],
    ['wordmark', page.getByRole('banner').getByRole('link', { name: 'imageboard' })],
    ['footer link', page.getByRole('contentinfo').getByRole('link', { name: 'GitHub', exact: true })],
    ['upload toggle', uploadToggle(page)],
  ];
  for (const [what, locator] of targets) {
    await locator.hover();
    await onEach(what);
  }
}

test.describe('reduced motion', () => {
  test.describe('with prefers-reduced-motion: reduce', () => {
    test.use({ reducedMotion: 'reduce' });

    test('F-60, B-76: nothing animates, transitions or transforms: on load, on hover, in the form and the dialog', async ({
      page,
    }) => {
      const image = await createImageViaApi(page.request, { title: uniqueTitle('F-60 reduce') });

      await page.goto('/');
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
      await revealTiles(page, [image.title]);

      const expectStill = async (state: string): Promise<void> => {
        const motion = await readMotion(page);
        expect(motion.animations, `running animations (${state})`).toEqual([]);
        expect(motion.declared, `declared animations or transitions (${state})`).toEqual([]);
        expect(motion.transformed, `transformed elements (${state})`).toEqual([]);
        expect(motion.scrollBehavior, `root scroll behaviour (${state})`).toBe('auto');
      };

      await expectStill('gallery loaded');
      await hoverMotionTargets(page, image.title, (what) => expectStill(`hovering the ${what}`));

      await uploadToggle(page).click();
      await expect(await uploadRegion(page)).toBeVisible();
      await expectStill('upload form open');

      await tileLink(page, image.title).click();
      const dialog = page.getByRole('dialog', { name: image.title });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'close' }).hover();
      await expectStill('detail dialog open');

      await expectNoA11yViolations(page);
    });
  });

  test.describe('without a motion preference', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('F-60, B-76: motion exists only as fades and hover shakes, never as a hover scale', async ({ page }) => {
      const image = await createImageViaApi(page.request, { title: uniqueTitle('F-60 motion') });

      await page.goto('/');
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: no-preference)').matches)).toBe(true);
      await revealTiles(page, [image.title]);

      // Control for the reduced-motion test: the same detection does see motion when motion is allowed.
      const loaded = await readMotion(page);
      expect(loaded.declared.some((entry) => entry.startsWith('animation fade-in'))).toBe(true);
      expect(loaded.scrollBehavior).toBe('smooth');

      await uploadToggle(page).click();
      const region = await uploadRegion(page);
      await expect(region).toBeVisible();
      expect(await region.evaluate((element) => getComputedStyle(element).animationName)).toBe('fade-in');

      // Hover effects exist only for devices that can hover (they would stick after a tap otherwise), and they are
      // shakes (translate keyframes), never a zoom like the legacy `scale(1.2)`.
      const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
      const title = tileLink(page, image.title).getByText(image.title, { exact: true });
      await tileLink(page, image.title).hover();
      expect(await title.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        canHover ? 'shake' : 'none',
      );
      await hoverMotionTargets(page, image.title, async (what) => {
        expect((await readMotion(page)).transformed, `transformed elements while hovering the ${what}`).toEqual([]);
      });

      await expectNoA11yViolations(page);
    });
  });
});
