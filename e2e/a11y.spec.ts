import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import { createCommentViaApi, createImageViaApi, type ImageInfo, uniqueTitle } from './support/api.ts';
import { imageFixture } from './support/files.ts';
import {
  detailDialog,
  dialogLiveRegion,
  galleryHeading,
  galleryRegion,
  IMAGES_PATH,
  openDetail as openDetailDialog,
  revealTiles,
  SERVICE_UNAVAILABLE,
  tileLink,
  uploadToggle,
} from './support/screens.ts';
import { fulfillServiceUnavailable } from './support/stubs.ts';

/**
 * Accessibility (F-50, F-51, F-52, F-56; regressions B-65, B-70, B-71, B-72).
 *
 * Data rules (ADR 0015): every test creates its own images and comments with unique titles. `page.request` shares the
 * page's cookie jar, so what it creates belongs to the page's session (delete controls visible); the `request`
 * fixture has its own session, so what it creates is foreign to the page. Helpers on `page.request` run before
 * `page.goto()` (see `support/api.ts`). Tiles are found with `revealTiles` (other workers may push them past the
 * first page); the empty gallery and the home tab walk use a `page.route` first page. Nothing counts tiles on the
 * shared stack.
 *
 * Live regions (F-56, ADR 0010): App.vue renders the app region (`data-region="app"`); every open ModalDialog renders
 * its own as a direct child of its `<dialog>`, because `showModal()` makes the page behind it inert. axe cannot see
 * a muted region, so the tests assert where each message is written.
 */

/** WCAG 2.4.13 / maw focus ring: at least 2 CSS px and 3:1 against what it is drawn on (F-51). */
const MIN_FOCUS_WIDTH_PX = 2;
const MIN_NON_TEXT_CONTRAST = 3;

/** Safety bounds for keyboard walks; a page or dialog with more stops than this is a failure, not a slow pass. */
const MAX_TAB_PRESSES = 40;
const MAX_HOME_TAB_STOPS = 80;
const MAX_DIALOG_TAB_STOPS = 30;

const COLOR_SCHEMES = ['light', 'dark'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Locators

function appLiveRegion(page: Page): Locator {
  return page.locator('[data-region="app"]');
}

/** The upload form is the only form with a "Title" field (the comment form has Name and Comment). */
function uploadForm(page: Page): Locator {
  return page.locator('form').filter({ has: page.getByLabel('Title', { exact: true }) });
}

// ---------------------------------------------------------------------------------------------------------------
// Colour maths (WCAG 2.2 relative luminance and contrast ratio)

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses a computed colour (`rgb(…)` / `rgba(…)`); anything else fails loudly instead of passing by accident. */
function parseColor(value: string): Rgba {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (match === null) throw new Error(`Unsupported computed colour "${value}"`);
  const [, r, g, b, alpha, percent] = match;
  const a = alpha === undefined ? 1 : Number(alpha) / (percent === '%' ? 100 : 1);
  return { r: Number(r), g: Number(g), b: Number(b), a };
}

function blend(top: Rgba, bottom: Rgba): Rgba {
  const mix = (front: number, back: number): number => front * top.a + back * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** Composites background layers (nearest first, as computed up the ancestor chain) down to the first opaque one. */
function compositeBackground(layers: readonly string[]): Rgba {
  const parsed = layers.map(parseColor);
  const opaqueIndex = parsed.findIndex((layer) => layer.a >= 1);
  if (opaqueIndex === -1) throw new Error(`No opaque background behind the element: ${layers.join(' → ')}`);
  let result = parsed[opaqueIndex]!;
  for (let index = opaqueIndex - 1; index >= 0; index -= 1) result = blend(parsed[index]!, result);
  return result;
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, backgroundLayers: readonly string[]): number {
  const background = compositeBackground(backgroundLayers);
  const front = blend(parseColor(foreground), background);
  const [lighter, darker] = [relativeLuminance(front), relativeLuminance(background)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

// ---------------------------------------------------------------------------------------------------------------
// Focus indicator (F-51, B-71)

interface FocusIndicator {
  kind: 'outline' | 'underline';
  widthPx: number;
  color: string;
  /** Non-transparent background colours behind the indicator, nearest first. */
  backgrounds: string[];
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FocusStop {
  /** e.g. `button "load more"`, for failure messages and walk summaries. */
  description: string;
  focusVisible: boolean;
  /** The element (or, for a visually hidden input, its visible stand-in) has a rendered box. */
  rendered: boolean;
  indicator: FocusIndicator | null;
  /**
   * Box the indicator is drawn around (border box, before the outline offset), in document coordinates, so it does not
   * depend on a smooth scroll that Tab may have started.
   */
  box: Box | null;
}

/**
 * Runs in the page. Reads the focused element's focus indicator from computed styles:
 * - an outline (the global `:focus-visible` ring; offset, so it is drawn on the parent's background),
 * - a stretched link's outline on its `::after` (ImageTile), drawn around the positioned ancestor it covers, or
 * - for text inputs, the 2px ink underline that replaces the ring (maw form field, OVERVIEW §17 B-71);
 * - a visually hidden native input (the file picker, B-67) is represented by the outlined element inside its label.
 * Returns `null` when focus is on the page itself.
 */
function readFocusStop(): FocusStop | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body || active === document.documentElement) {
    return null;
  }

  const describe = (element: HTMLElement): string => {
    // Only inputs carry their type: every button renders an explicit `type`, which says nothing about it.
    const type = element instanceof HTMLInputElement ? element.type : null;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id === '' ? '' : (document.getElementById(id)?.textContent ?? '')))
      .join(' ');
    const ownText =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? (element.labels?.[0]?.textContent ?? '')
        : element.textContent;
    const label = element.getAttribute('aria-label') ?? (labelledBy.trim() === '' ? ownText : labelledBy);
    const name = label.replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${element.tagName.toLowerCase()}${type === null ? '' : `[type=${type}]`} "${name}"`;
  };

  const backgroundsFrom = (start: Element | null): string[] => {
    const layers: string[] = [];
    for (let element = start; element !== null; element = element.parentElement) {
      const color = getComputedStyle(element).backgroundColor;
      if (color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color)) continue;
      layers.push(color);
    }
    return layers;
  };

  const box = active.getBoundingClientRect();
  const visuallyHidden = box.width <= 1 || box.height <= 1;
  const label = visuallyHidden ? active.closest('label') : null;
  const candidates: Element[] = visuallyHidden
    ? label === null
      ? []
      : [label, ...label.querySelectorAll('*')]
    : [active];

  const toBox = (rect: DOMRect): Box => ({
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    right: rect.right + window.scrollX,
    bottom: rect.bottom + window.scrollY,
  });

  let indicator: FocusIndicator | null = null;
  let rendered = false;
  let indicatorBox: Box | null = null;
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) continue;
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    const outlineWidth = Number.parseFloat(style.outlineWidth);
    if (style.outlineStyle !== 'none' && outlineWidth > 0) {
      indicator = {
        kind: 'outline',
        widthPx: outlineWidth,
        color: style.outlineColor,
        backgrounds: backgroundsFrom(candidate.parentElement),
      };
      rendered = rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
      indicatorBox = toBox(rect);
      break;
    }
    const after = getComputedStyle(candidate, '::after');
    const afterWidth = Number.parseFloat(after.outlineWidth);
    if (candidate === active && after.content !== 'none' && after.outlineStyle !== 'none' && afterWidth > 0) {
      // An absolutely positioned `::after` covers its containing block (the offset parent), so the ring is there.
      const covered = after.position === 'absolute' ? (candidate.offsetParent ?? candidate) : candidate;
      const coveredRect = covered.getBoundingClientRect();
      indicator = {
        kind: 'outline',
        widthPx: afterWidth,
        color: after.outlineColor,
        backgrounds: backgroundsFrom(covered.parentElement),
      };
      rendered = coveredRect.width > 0 && coveredRect.height > 0 && style.visibility === 'visible';
      indicatorBox = toBox(coveredRect);
      break;
    }
    const underlineWidth = Number.parseFloat(style.borderBottomWidth);
    if (candidate === active && style.borderBottomStyle !== 'none' && underlineWidth >= 2) {
      indicator = {
        kind: 'underline',
        widthPx: underlineWidth,
        color: style.borderBottomColor,
        backgrounds: backgroundsFrom(candidate),
      };
      rendered = rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
      indicatorBox = toBox(rect);
      break;
    }
  }

  return {
    description: describe(active),
    focusVisible: active.matches(':focus-visible'),
    rendered,
    indicator,
    box: indicatorBox,
  };
}

/** Asserts that keyboard focus is on an element that shows a ≥ 2px indicator with ≥ 3:1 contrast. */
async function expectVisibleFocusIndicator(page: Page): Promise<FocusStop> {
  const stop = await page.evaluate(readFocusStop);
  expect(stop, 'keyboard focus is on an element, not on the page').not.toBeNull();
  const { description, focusVisible, rendered, indicator } = stop!;
  expect(focusVisible, `${description} matches :focus-visible`).toBe(true);
  expect(indicator, `${description} shows a focus indicator (outline or 2px underline)`).not.toBeNull();
  expect(rendered, `${description}: the element that carries the indicator is rendered`).toBe(true);
  expect(indicator!.widthPx, `${description}: indicator width`).toBeGreaterThanOrEqual(MIN_FOCUS_WIDTH_PX);
  const ratio = contrastRatio(indicator!.color, indicator!.backgrounds);
  expect(
    ratio,
    `${description}: ${indicator!.kind} ${indicator!.color} on ${indicator!.backgrounds.join(' over ')}`,
  ).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);
  return stop!;
}

async function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((element) => element === document.activeElement);
}

/**
 * Presses Tab (or Shift+Tab) until `target` has focus, checking the focus indicator at every stop on the way, so a
 * journey proves both reachability and visibility (F-51). Fails after `MAX_TAB_PRESSES`.
 */
async function tabTo(page: Page, target: Locator, direction: 'forward' | 'backward' = 'forward'): Promise<void> {
  const key = direction === 'forward' ? 'Tab' : 'Shift+Tab';
  const passed: string[] = [];
  for (let presses = 0; presses < MAX_TAB_PRESSES; presses += 1) {
    await page.keyboard.press(key);
    const stop = await expectVisibleFocusIndicator(page);
    if (await isFocused(target)) return;
    passed.push(stop.description);
  }
  throw new Error(`${key} did not reach the target within ${String(MAX_TAB_PRESSES)} presses: ${passed.join(', ')}`);
}

/**
 * Walks the sequential focus order from the current focus until focus returns to where the walk started or leaves the
 * document (after the last stop), checking every stop. Returns the stop descriptions in order.
 */
async function walkTabStops(
  page: Page,
  maxStops: number,
  onStop?: (stop: FocusStop) => Promise<void>,
): Promise<string[]> {
  const start = await page.evaluateHandle(() => document.activeElement);
  const stops: string[] = [];
  try {
    for (let index = 0; index < maxStops; index += 1) {
      await page.keyboard.press('Tab');
      const onPage = await page.evaluate(
        () => document.activeElement === null || document.activeElement === document.body,
      );
      if (onPage) return stops;
      if (await page.evaluate((element) => element === document.activeElement, start)) return stops;
      const stop = await expectVisibleFocusIndicator(page);
      stops.push(stop.description);
      if (onStop !== undefined) await onStop(stop);
    }
  } finally {
    await start.dispose();
  }
  throw new Error(`More than ${String(maxStops)} tab stops: ${stops.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Live regions (F-56)

/** The region is not muted: it sits in no inert subtree and, inside a dialog, that dialog is the open modal one. */
async function expectAudibleRegion(region: Locator): Promise<void> {
  const audible = await region.evaluate((element) => {
    if (element.closest('[inert]') !== null) return false;
    const dialog = element.closest('dialog');
    return dialog === null || dialog.matches(':modal');
  });
  expect(audible, 'live region is outside every inert subtree').toBe(true);
  await expect(region).toHaveAttribute('aria-live', 'polite');
}

/** True while `element` is inside the given dialog and that dialog is the top-most open modal one. */
async function isInTopMostDialog(element: Locator, dialog: Locator): Promise<boolean> {
  const dialogHandle = await dialog.elementHandle();
  try {
    return await element.evaluate((node, owner: Element) => {
      if (node.closest('dialog') !== owner || !owner.matches(':modal')) return false;
      // Modal dialogs nest in the DOM here (a confirmation inside the detail dialog): none may sit inside this one.
      return [...owner.querySelectorAll('dialog')].every((nested) => !nested.matches(':modal'));
    }, dialogHandle);
  } finally {
    await dialogHandle.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Screens

/** Creates an image owned by the page's session (before navigation, see `support/api.ts`). */
async function createOwnImage(page: Page, label: string, description = 'Flat colour test image.'): Promise<ImageInfo> {
  return createImageViaApi(page.request, { title: uniqueTitle(label), description });
}

/** Opens `/images/:id` directly and waits until the image and its comments have loaded. */
async function openDetail(page: Page, image: ImageInfo): Promise<Locator> {
  const dialog = await openDetailDialog(page, image);
  await expect(dialog.getByRole('heading', { level: 3, name: 'Comments', exact: true })).toBeVisible();
  await expect(dialog.getByText('Loading comments…')).toHaveCount(0);
  return dialog;
}

async function openUploadForm(page: Page): Promise<Locator> {
  await uploadToggle(page).click();
  await expect(uploadToggle(page)).toHaveAttribute('aria-expanded', 'true');
  const form = uploadForm(page);
  await expect(form).toBeVisible();
  return form;
}

/**
 * Answers `GET /api/images` with one fixed page and no further one: the empty state (F-07) for `[]`, or exactly the
 * test's own tiles on the first page, whatever other workers upload meanwhile.
 */
async function routeGalleryPage(page: Page, items: readonly ImageInfo[]): Promise<void> {
  await page.route(
    (url) => url.pathname === IMAGES_PATH,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, json: { items, nextCursor: null } });
    },
  );
}

/** Answers a request with a 503 that has no problem body, as nginx does when the API is down. */
async function routeServiceUnavailable(page: Page, method: string, matches: (url: URL) => boolean): Promise<void> {
  await page.route(matches, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    return fulfillServiceUnavailable(route);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// F-50: axe on every main screen, light and dark

test.describe('F-50: no serious or critical axe violations (WCAG 2.2 AA), light and dark', () => {
  test('F-50: gallery with images', async ({ page }) => {
    const image = await createOwnImage(page, 'A11y filled gallery');
    await page.goto('/');
    await revealTiles(page, [image.title]);

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-50: empty gallery', async ({ page }) => {
    await routeGalleryPage(page, []);
    await page.goto('/');
    await expect(page.getByText('No images yet.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'upload an image', exact: true })).toBeVisible();

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-50: open detail dialog with description and comments', async ({ page, request }) => {
    const image = await createOwnImage(page, 'A11y detail', 'A description\nover two lines.');
    await createCommentViaApi(page.request, image.id, { body: 'An own comment with a delete button.' });
    await createCommentViaApi(request, image.id, { body: 'A foreign comment without one.' });
    const dialog = await openDetail(page, image);
    await expect(dialog.getByRole('article')).toHaveCount(2);

    await expectNoA11yViolationsInBothColorSchemes(page);
    // The dialog on its own, too: a modal dialog's contents are what assistive technology exposes.
    await expectNoA11yViolationsInBothColorSchemes(page, { include: 'dialog[open]' });
  });

  test('F-50: upload form with validation errors', async ({ page }) => {
    await page.goto('/');
    const form = await openUploadForm(page);
    await form.getByRole('button', { name: 'upload image', exact: true }).click();
    await expect(form.getByText('Enter a name.', { exact: true })).toBeVisible();
    await expect(form.getByText('Enter a title.', { exact: true })).toBeVisible();
    await expect(form.getByText('Choose an image to upload.', { exact: true })).toBeVisible();

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-50: delete confirmations (image and comment)', async ({ page }) => {
    const image = await createOwnImage(page, 'A11y confirm');
    await createCommentViaApi(page.request, image.id, { body: 'Comment to confirm deleting.' });
    const dialog = await openDetail(page, image);

    await dialog.getByRole('button', { name: 'delete image', exact: true }).click();
    const confirmImage = page.getByRole('dialog', { name: 'Delete this image?', exact: true });
    await expect(confirmImage).toBeVisible();
    await expectNoA11yViolationsInBothColorSchemes(page);
    await confirmImage.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(confirmImage).toBeHidden();

    await dialog.getByRole('button', { name: 'delete comment', exact: true }).click();
    const confirmComment = page.getByRole('dialog', { name: 'Delete this comment?', exact: true });
    await expect(confirmComment).toBeVisible();
    await expectNoA11yViolationsInBothColorSchemes(page);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F-52 / B-72: contrast

/** Runs only axe's `color-contrast` rule and requires that it actually checked text (passes) and found nothing. */
async function expectColorContrastPasses(page: Page, include?: string): Promise<void> {
  for (const colorScheme of COLOR_SCHEMES) {
    await test.step(`color-contrast in the ${colorScheme} colour scheme`, async () => {
      await page.emulateMedia({ colorScheme });
      await page.evaluate(async () => {
        const finite = document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
        await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
      });
      let builder = new AxeBuilder({ page }).withRules(['color-contrast']);
      if (include !== undefined) builder = builder.include(include);
      const results = await builder.analyze();
      const checked = results.passes.find((rule) => rule.id === 'color-contrast')?.nodes.length ?? 0;
      expect(checked, 'color-contrast checked text nodes').toBeGreaterThan(0);
      const report = results.violations
        .flatMap((violation) => violation.nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`))
        .join('\n');
      expect(results.violations, `contrast failures:\n${report}`).toEqual([]);
    });
  }
  await page.emulateMedia({ colorScheme: null });
}

test('F-52, B-72: home page text (tiles, muted meta, labels, hints, errors, footer) meets 4.5:1, light and dark', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y contrast home');
  await page.goto('/');
  await revealTiles(page, [image.title]);
  const form = await openUploadForm(page);
  await form.getByRole('button', { name: 'upload image', exact: true }).click();
  await expect(form.getByText('Enter a name.', { exact: true })).toBeVisible();

  await expectColorContrastPasses(page);
});

test('F-52, B-72: detail dialog text (meta, comments, labels) meets 4.5:1, light and dark', async ({ page }) => {
  const image = await createOwnImage(page, 'A11y contrast detail');
  await createCommentViaApi(page.request, image.id, { body: 'Contrast check comment.' });
  await openDetail(page, image);

  await expectColorContrastPasses(page, 'dialog[open]');
});

test('F-52: form field boundaries (input underlines) reach 3:1 against the page, light and dark', async ({ page }) => {
  for (const colorScheme of COLOR_SCHEMES) {
    await test.step(colorScheme, async () => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      const form = await openUploadForm(page);
      // Opening focuses the Name field; measure the resting state of every field.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      const fields = form.locator('input:not([type="file"]), textarea');
      await expect(fields).toHaveCount(3);
      for (const field of await fields.all()) {
        const boundary = await field.evaluate((element) => {
          const layers: string[] = [];
          for (let node: Element | null = element; node !== null; node = node.parentElement) {
            const color = getComputedStyle(node).backgroundColor;
            if (color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) layers.push(color);
          }
          const style = getComputedStyle(element);
          return {
            name: element.getAttribute('name') ?? element.tagName,
            width: Number.parseFloat(style.borderBottomWidth),
            color: style.borderBottomColor,
            layers,
          };
        });
        expect(boundary.width, `${boundary.name}: underline is drawn`).toBeGreaterThan(0);
        expect(
          contrastRatio(boundary.color, boundary.layers),
          `${boundary.name}: ${boundary.color} on ${boundary.layers.join(' over ')}`,
        ).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// F-51 / B-71: keyboard and focus

test('F-51, B-71: every tab stop on the home page shows a focus indicator of ≥ 2px and ≥ 3:1, light and dark', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y tab walk home');
  // Only this test's tile, on the first page: the walk starts at the top of the document, so it cannot page with
  // "load more" first, and other workers may have pushed the tile off the real first page meanwhile.
  await routeGalleryPage(page, [image]);

  for (const colorScheme of COLOR_SCHEMES) {
    await test.step(colorScheme, async () => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await expect(tileLink(page, image.title)).toBeVisible();

      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'skip to content', exact: true })).toBeFocused();
      await expectVisibleFocusIndicator(page);

      const toggle = uploadToggle(page);
      const stops = await walkTabStops(page, MAX_HOME_TAB_STOPS, async () => {
        // Expand the upload form from the keyboard on the way, so its fields are part of the walk.
        if ((await isFocused(toggle)) && (await toggle.getAttribute('aria-expanded')) === 'false') {
          await page.keyboard.press('Enter');
          await expect(uploadForm(page).getByLabel('Name (shown publicly)', { exact: true })).toBeFocused();
          await expectVisibleFocusIndicator(page);
        }
      });

      // Every kind of control was part of the walk, the visually hidden file input included (B-67).
      expect(stops).toContain('a "imageboard"');
      expect(stops).toContain('button "Upload an image"');
      expect(stops).toContain('input[type=text] "Title"');
      expect(stops).toContain('textarea "Description (optional)"');
      expect(stops).toContain('input[type=file] "Image choose an image"');
      expect(stops).toContain('button "upload image"');
      expect(stops).toContain(`a "${image.title}"`);
      expect(stops).toContain('a "GitHub"');
      expect(stops).toContain('a "LinkedIn"');
    });
  }
  await page.emulateMedia({ colorScheme: null });
  await expectNoA11yViolations(page);
});

test('F-51, B-71: every tab stop in the open detail dialog shows a focus indicator of ≥ 2px and ≥ 3:1, light and dark', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y tab walk dialog');
  await createCommentViaApi(page.request, image.id, { body: 'Own comment for the tab walk.' });

  for (const colorScheme of COLOR_SCHEMES) {
    await test.step(colorScheme, async () => {
      await page.emulateMedia({ colorScheme });
      const dialog = await openDetail(page, image);
      const close = dialog.getByRole('button', { name: 'close', exact: true });
      await expect(close).toBeFocused();

      const stops = await walkTabStops(page, MAX_DIALOG_TAB_STOPS, async () => {
        const inside = await page.evaluate(() => document.activeElement?.closest('dialog[open]') !== null);
        expect(inside, 'focus stays inside the open dialog').toBe(true);
      });

      expect(stops).toEqual([
        'button "delete image"',
        'input[type=text] "Name (shown publicly)"',
        'textarea "Comment"',
        'button "post comment"',
        'button "delete comment"',
      ]);
      // The walk ended back on "close" (focus wrapped inside the dialog) or left the document past the last stop.
      await expect(dialog).toBeVisible();
    });
  }
  await page.emulateMedia({ colorScheme: null });
  await expectNoA11yViolations(page, { include: 'dialog[open]' });
});

test('F-51: keyboard only: skip link, upload, open the image, comment, delete the comment and the image', async ({
  page,
}) => {
  const title = uniqueTitle('A11y keyboard journey');
  const commentBody = 'Written with the keyboard only.';
  await page.goto('/');

  await test.step('skip link moves focus to the main content', async () => {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'skip to content', exact: true })).toBeFocused();
    await expectVisibleFocusIndicator(page);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await expect(page).toHaveURL(/\/$/); // focus moved without a `#main` fragment (B-59)
    await page.keyboard.press('Tab');
    await expect(uploadToggle(page)).toBeFocused();
    await expectVisibleFocusIndicator(page);
  });

  const form = uploadForm(page);
  await test.step('upload an image with the keyboard (file picker opened with Space)', async () => {
    await page.keyboard.press('Enter');
    await expect(uploadToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(form.getByLabel('Name (shown publicly)', { exact: true })).toBeFocused();
    await page.keyboard.type('Keyboard Tester');
    await page.keyboard.press('Tab');
    await expect(form.getByLabel('Title', { exact: true })).toBeFocused();
    await expectVisibleFocusIndicator(page);
    await page.keyboard.type(title);
    await page.keyboard.press('Tab');
    await expect(form.getByLabel('Description (optional)', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const fileInput = form.locator('input[type="file"]');
    await expect(fileInput).toBeFocused();
    await expectVisibleFocusIndicator(page);

    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await chooser).setFiles(imageFixture('portraitPng'));
    await expect(form.getByText(/^portrait\.png, /)).toBeVisible();

    await tabTo(page, form.getByRole('button', { name: 'upload image', exact: true }));
    await page.keyboard.press('Enter');
    await expect(appLiveRegion(page)).toHaveText('Image uploaded.');
    await expect(tileLink(page, title)).toBeVisible();
  });

  const dialog = detailDialog(page, title);
  await test.step('open the new tile with Enter; focus starts on "close"', async () => {
    await tabTo(page, tileLink(page, title));
    // The ring surrounds the whole tile, author and date included: the area the stretched link covers.
    const { box } = await expectVisibleFocusIndicator(page);
    const tileItem = galleryRegion(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: title, exact: true }) });
    // Document coordinates on both sides: Tab may still be smooth-scrolling the tile into view.
    const author = await tileItem.getByText('Keyboard Tester', { exact: true }).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY,
      };
    });
    expect(box, 'the focus ring has a box').not.toBeNull();
    expect(box!.left, 'ring starts left of the author').toBeLessThanOrEqual(author.left);
    expect(box!.right, 'ring ends right of the author').toBeGreaterThanOrEqual(author.right);
    expect(box!.top, 'ring starts above the author').toBeLessThanOrEqual(author.top);
    expect(box!.bottom, 'ring ends below the author').toBeGreaterThanOrEqual(author.bottom);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/images\/\d+$/);
    await expect(dialog.getByRole('button', { name: 'close', exact: true })).toBeFocused();
  });

  await test.step('add a comment', async () => {
    await tabTo(page, dialog.getByLabel('Name (shown publicly)', { exact: true }));
    await page.keyboard.type('Keyboard Tester');
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Comment', { exact: true })).toBeFocused();
    await page.keyboard.type(commentBody);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'post comment', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialogLiveRegion(dialog)).toHaveText('Comment added.');
    await expect(dialog.getByRole('article').filter({ hasText: commentBody })).toBeVisible();
  });

  await test.step('delete the comment; the confirmation starts on "cancel"', async () => {
    await tabTo(page, dialog.getByRole('button', { name: 'delete comment', exact: true }));
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Delete this comment?', exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'cancel', exact: true })).toBeFocused();
    await expectVisibleFocusIndicator(page);
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'delete', exact: true })).toBeFocused();
    await expectVisibleFocusIndicator(page);
    await page.keyboard.press('Enter');
    await expect(confirm).toBeHidden();
    await expect(dialogLiveRegion(dialog)).toHaveText('Comment deleted.');
    await expect(dialog.getByRole('article')).toHaveCount(0);
    await expect(dialog.getByRole('heading', { level: 3, name: 'Comments', exact: true })).toBeFocused();
  });

  await test.step('Esc cancels the image confirmation, then delete the image', async () => {
    const deleteImage = dialog.getByRole('button', { name: 'delete image', exact: true });
    await tabTo(page, deleteImage, 'backward');
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Delete this image?', exact: true });
    await expect(confirm.getByRole('button', { name: 'cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(deleteImage).toBeFocused();
    await expectVisibleFocusIndicator(page);

    await page.keyboard.press('Enter');
    await expect(confirm.getByRole('button', { name: 'cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'delete', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(appLiveRegion(page)).toHaveText('Image deleted.');
    await expect(tileLink(page, title)).toHaveCount(0);
    await expect(galleryHeading(page)).toBeFocused();
  });

  await expectNoA11yViolations(page);
});

// ---------------------------------------------------------------------------------------------------------------
// F-56: announcements and focus on blocked forms

test('F-56: a blocked upload moves focus to the first invalid field, in form order', async ({ page }) => {
  await page.goto('/');
  const form = await openUploadForm(page);
  const submit = form.getByRole('button', { name: 'upload image', exact: true });
  const name = form.getByLabel('Name (shown publicly)', { exact: true });
  const title = form.getByLabel('Title', { exact: true });

  await submit.click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('Enter a name.');

  await name.fill('Focus Tester');
  await submit.click();
  await expect(title).toBeFocused();
  await expect(title).toHaveAccessibleDescription('Enter a title.');

  await title.fill(uniqueTitle('A11y blocked upload'));
  await submit.click();
  const fileInput = form.locator('input[type="file"]');
  await expect(fileInput).toBeFocused();
  await expect(fileInput).toHaveAttribute('aria-invalid', 'true');
  await expect(fileInput).toHaveAccessibleDescription(/Choose an image to upload\./);

  await expectNoA11yViolations(page);
});

test('F-56: a failed upload is an alert; a successful upload is announced in the app live region', async ({ page }) => {
  const title = uniqueTitle('A11y announced upload');
  await page.goto('/');
  const region = appLiveRegion(page);
  await expectAudibleRegion(region);
  await expect(region).toHaveText('');

  const form = await openUploadForm(page);
  await form.getByLabel('Name (shown publicly)', { exact: true }).fill('Announcement Tester');
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.locator('input[type="file"]').setInputFiles(imageFixture('squareGif'));
  const submit = form.getByRole('button', { name: 'upload image', exact: true });

  await routeServiceUnavailable(page, 'POST', (url) => url.pathname === IMAGES_PATH);
  await submit.click();
  await expect(form.getByRole('alert')).toHaveText(SERVICE_UNAVAILABLE);
  await expect(region).not.toHaveText('Image uploaded.');
  await expect(submit).toBeFocused(); // the alert speaks for itself; focus stays where the person is

  await page.unrouteAll({ behavior: 'wait' });
  await submit.click();
  await expect(region).toHaveText('Image uploaded.');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(tileLink(page, title)).toBeVisible();

  await expectNoA11yViolations(page);
});

test('F-56: inside the open dialog, comment messages go to a live region of that dialog; a blocked comment focuses the first invalid field', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y dialog announcements');
  const body = 'Announced inside the dialog.';
  const dialog = await openDetail(page, image);
  const region = dialogLiveRegion(dialog);
  await expect(region).toHaveCount(1);
  await expectAudibleRegion(region);
  const name = dialog.getByLabel('Name (shown publicly)', { exact: true });
  const comment = dialog.getByLabel('Comment', { exact: true });
  const post = dialog.getByRole('button', { name: 'post comment', exact: true });

  await post.click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription('Enter a name.');
  await name.fill('Announcement Tester');
  await post.click();
  await expect(comment).toBeFocused();
  await expect(comment).toHaveAccessibleDescription('Write a comment.');

  await comment.fill(body);
  await post.click();
  await expect(region).toHaveText('Comment added.');
  await expect(appLiveRegion(page)).not.toHaveText('Comment added.');
  await expect(dialog.getByRole('article').filter({ hasText: body })).toBeVisible();

  await dialog.getByRole('button', { name: 'delete comment', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this comment?', exact: true });
  await expect(confirm).toBeVisible();
  // While the confirmation is the top-most dialog it has its own region (the detail dialog is inert behind it).
  await expect(dialogLiveRegion(confirm)).toHaveCount(1);
  await confirm.getByRole('button', { name: 'delete', exact: true }).click();
  await expect(confirm).toBeHidden();
  // Written after the confirmation closed, so into the detail dialog's region, which is live again.
  await expect(region).toHaveText('Comment deleted.');
  await expectAudibleRegion(region);
  await expect(appLiveRegion(page)).not.toHaveText('Comment deleted.');

  await expectNoA11yViolations(page, { include: 'dialog[open]' });
});

test('F-56: a failed delete is an alert inside the confirmation, the top-most dialog', async ({ page }) => {
  const image = await createOwnImage(page, 'A11y failed delete');
  const own = await createCommentViaApi(page.request, image.id, { body: 'This delete will fail once.' });
  await routeServiceUnavailable(page, 'DELETE', (url) => url.pathname === `/api/comments/${String(own.id)}`);
  const dialog = await openDetail(page, image);

  await dialog.getByRole('button', { name: 'delete comment', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this comment?', exact: true });
  await confirm.getByRole('button', { name: 'delete', exact: true }).click();

  const alert = confirm.getByRole('alert');
  await expect(alert).toHaveText(SERVICE_UNAVAILABLE);
  expect(await isInTopMostDialog(alert, confirm), 'the alert is inside the top-most modal dialog').toBe(true);
  await expect(confirm.getByRole('button', { name: 'delete', exact: true })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(dialog.getByRole('article').filter({ hasText: own.body })).toBeVisible();

  await expectNoA11yViolations(page, { include: 'dialog[open]' });
});

test('F-56: "Image deleted." is announced in the app live region once the dialog has closed', async ({ page }) => {
  const image = await createOwnImage(page, 'A11y announced delete');
  await page.goto('/');
  await revealTiles(page, [image.title]);
  await tileLink(page, image.title).click();
  const dialog = detailDialog(page, image.title);
  await expect(dialog.getByRole('img', { name: image.title, exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'delete image', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete this image?', exact: true })
    .getByRole('button', { name: 'delete', exact: true })
    .click();

  await expect(dialog).toBeHidden();
  const region = appLiveRegion(page);
  await expect(region).toHaveText('Image deleted.');
  await expectAudibleRegion(region);
  await expect(tileLink(page, image.title)).toHaveCount(0);

  await expectNoA11yViolations(page);
});

// ---------------------------------------------------------------------------------------------------------------
// B-65, B-70: text alternatives and heading outline

test('B-65: tile image has alt="" inside a link named exactly by the title; the dialog image is named by the title', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y alt text');
  await page.goto('/');
  await revealTiles(page, [image.title]);

  const tile = tileLink(page, image.title);
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAccessibleName(image.title);
  const tileImage = tile.locator('img');
  await expect(tileImage).toHaveAttribute('alt', '');
  // alt="" makes it presentational: the title is read once, from the link's text (WCAG H2).
  await expect(tile.getByRole('img')).toHaveCount(0);

  await tile.click();
  const dialog = detailDialog(page, image.title);
  const dialogImage = dialog.getByRole('img', { name: image.title, exact: true });
  await expect(dialogImage).toBeVisible();
  await expect(dialogImage).toHaveAttribute('alt', image.title);

  await expectNoA11yViolations(page);
});

test('B-70: one h1, the sections as h2, the image title as the dialog h2, "Comments" as h3, comments as an ordered list of articles', async ({
  page,
}) => {
  const image = await createOwnImage(page, 'A11y outline');
  await createCommentViaApi(page.request, image.id, { body: 'Outline comment one.' });
  await createCommentViaApi(page.request, image.id, { body: 'Outline comment two.' });
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'imageboard', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Upload an image', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Gallery', exact: true })).toBeVisible();
  // No heading is used for anything below h3 (B-70: comment bodies used to be h6).
  await expect(page.locator('h4, h5, h6')).toHaveCount(0);

  const dialog = await openDetail(page, image);
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText([image.title]);
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Comments']);
  await expect(dialog.locator('h1, h4, h5, h6')).toHaveCount(0);

  const list = dialog.locator('ol').filter({ has: page.getByRole('article') });
  await expect(list).toHaveCount(1);
  await expect(list.locator(':scope > li > article')).toHaveCount(2);
  await expect(list.getByRole('article').first()).toContainText('Outline comment two.'); // newest first
  for (const article of await list.getByRole('article').all()) {
    await expect(article.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
  }

  await expectNoA11yViolations(page, { include: 'dialog[open]' });
});
