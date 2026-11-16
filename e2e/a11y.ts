import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA (F-50, F-52). */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Definition of Done: no serious or critical axe findings. Moderate and minor ones are reviewed by hand. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

export interface A11yOptions {
  /** Analyse only this part of the page, e.g. `'dialog[open]'`. Default: the whole document. */
  include?: string;
}

/**
 * Waits until every finite CSS animation and transition has finished, so axe never measures colour contrast halfway
 * through a fade (dialog open, row highlight). Infinite animations (a loading indicator) are not awaited. Cancelled
 * animations reject `finished`, which counts as settled.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/**
 * Fails on serious and critical WCAG 2.2 A/AA violations in the current colour scheme. Every journey calls it on its
 * final screen; main screens also go through `expectNoA11yViolationsInBothColorSchemes`.
 */
export async function expectNoA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.include !== undefined) builder = builder.include(options.include);
  const results = await builder.analyze();

  const blocking = results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''));
  const report = blocking
    .map((violation) => {
      const targets = violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n');
      return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n  ${violation.helpUrl}\n${targets}`;
    })
    .join('\n');
  expect(blocking, `axe found serious or critical violations:\n${report}`).toEqual([]);
}

/**
 * Runs `expectNoA11yViolations` in the light and in the dark colour scheme (the app follows `prefers-color-scheme`,
 * tokens.css) without reloading, so the screen under test keeps its state. Afterwards the context's own colour
 * scheme applies again.
 */
export async function expectNoA11yViolationsInBothColorSchemes(page: Page, options: A11yOptions = {}): Promise<void> {
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await test.step(`axe in the ${colorScheme} colour scheme`, async () => {
        await page.emulateMedia({ colorScheme });
        const applied = await page.evaluate(
          (scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches,
          colorScheme,
        );
        expect(applied, `prefers-color-scheme: ${colorScheme} is emulated`).toBe(true);
        await expectNoA11yViolations(page, options);
      });
    }
  } finally {
    await page.emulateMedia({ colorScheme: null });
  }
}
