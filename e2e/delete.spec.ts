import { expect, type Locator, type Page, test } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import {
  createCommentViaApi,
  createImagesViaApi,
  createImageViaApi,
  expectProblem,
  getImageViaApi,
  getSessionViaApi,
  type ImageInfo,
  MAX_ID,
  uniqueTitle,
} from './support/api.ts';
import {
  detailDialog,
  galleryHeading,
  openDetail,
  revealTiles,
  SERVICE_UNAVAILABLE,
  tileLink,
} from './support/screens.ts';

/**
 * Deleting an image (F-35 to F-37; regressions B-02, B-07, B-22, B-47, B-56).
 *
 * Data rules (ADR 0015): every test creates its own images with unique titles. `page.request` shares the page's
 * cookie jar, so what it creates belongs to the page's session; the `request` fixture has its own session, so what it
 * creates is foreign to the page. Helpers on `page.request` run before `page.goto()` (see `support/api.ts`). Nothing
 * counts gallery tiles across the shared stack.
 */

/** Wording of the confirmation (F-37). The maw button labels are lowercase; F-37's "Delete" / "Cancel" are these. */
const CONFIRM_TITLE = 'Delete this image?';
const CONFIRM_MESSAGE = 'This cannot be undone.';

function confirmDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: CONFIRM_TITLE, exact: true });
}

function deleteImageButton(page: Page): Locator {
  return page.getByRole('button', { name: 'delete image', exact: true });
}

test.describe('delete an image', () => {
  test('F-35, B-02: "delete image" is offered for the own image only', async ({ page, request }) => {
    const own = await createImageViaApi(page.request, { title: uniqueTitle('Delete own') });
    const foreign = await createImageViaApi(request, { title: uniqueTitle('Delete foreign') });
    expect(own.canDelete).toBe(true);
    expect((await getImageViaApi(page.request, foreign.id))?.canDelete).toBe(false);

    const ownDialog = await openDetail(page, own);
    await expect(ownDialog.getByRole('button', { name: 'delete image', exact: true })).toBeVisible();

    const foreignDialog = await openDetail(page, foreign);
    // The image and its metadata are loaded, so the missing button is the decision, not a loading state.
    await expect(foreignDialog.getByText(`Posted by ${foreign.authorName}`)).toBeVisible();
    await expect(deleteImageButton(page)).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

  test('F-35, B-02: the API deletes only for the uploader (403 not-owner, 404 unknown, 403 without CSRF)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const image = await createImageViaApi(request, { title: uniqueTitle('Delete owner check') });
    const path = `/api/images/${String(image.id)}`;
    const foreign = await playwright.request.newContext({ baseURL: baseURL ?? '' });
    try {
      const { csrfToken: foreignToken } = await getSessionViaApi(foreign);
      await expectProblem(await foreign.delete(path, { headers: { 'x-csrf-token': foreignToken } }), 403, 'not-owner');
    } finally {
      await foreign.dispose();
    }

    await expectProblem(await request.delete(path), 403, 'csrf-invalid');
    expect(await getImageViaApi(request, image.id), 'refused deletes leave the image').not.toBeNull();

    const { csrfToken } = await getSessionViaApi(request);
    const headers = { 'x-csrf-token': csrfToken };
    await expectProblem(await request.delete(`/api/images/${String(MAX_ID)}`, { headers }), 404, 'not-found');

    const deleted = await request.delete(path, { headers });
    expect(deleted.status()).toBe(204);
    expect(await deleted.body()).toHaveLength(0);
    expect(await getImageViaApi(request, image.id)).toBeNull();
  });

  test('F-37, B-56: the confirmation is an accessible dialog with focus on cancel; cancel and Esc keep the image', async ({
    page,
  }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Delete cancel') });
    const dialog = await openDetail(page, image);

    await deleteImageButton(page).click();
    const confirm = confirmDialog(page);
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('heading', { name: CONFIRM_TITLE, exact: true })).toBeVisible();
    await expect(confirm.getByText(CONFIRM_MESSAGE, { exact: true })).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'delete', exact: true })).toBeVisible();
    const cancel = confirm.getByRole('button', { name: 'cancel', exact: true });
    await expect(cancel).toBeFocused();
    await expectNoA11yViolationsInBothColorSchemes(page, { include: 'dialog[open]' });

    // Enter on the initially focused button cancels: nothing is destroyed by reflex.
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(deleteImageButton(page)).toBeFocused();

    await deleteImageButton(page).click();
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    // Esc closes only the confirmation, not the detail dialog underneath.
    await expect(dialog).toBeVisible();
    await expect(deleteImageButton(page)).toBeFocused();

    expect(await getImageViaApi(page.request, image.id), 'cancelling deletes nothing').not.toBeNull();
    await expectNoA11yViolations(page);
  });

  test('F-36, B-07, B-22: deleting removes the image, its comments and both media files', async ({ page, request }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Delete cascade') });
    await createCommentViaApi(page.request, image.id, { body: 'Own comment that goes with the image.' });
    await createCommentViaApi(request, image.id, { body: 'Foreign comment that goes with the image too.' });
    for (const url of [image.url, image.previewUrl]) {
      expect((await request.get(url)).status(), `${url} is served before the delete`).toBe(200);
    }

    const dialog = await openDetail(page, image);
    await expect(dialog.getByText('Foreign comment that goes with the image too.')).toBeVisible();
    await deleteImageButton(page).click();
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && response.url().endsWith(`/api/images/${String(image.id)}`),
    );
    await confirmDialog(page).getByRole('button', { name: 'delete', exact: true }).click();
    expect((await deleteResponse).status()).toBe(204);
    await expect(dialog).toHaveCount(0);

    // Checked from a different session: the image is gone for everyone, not just hidden for the owner.
    expect(await getImageViaApi(request, image.id)).toBeNull();
    const comments = await request.get(`/api/images/${String(image.id)}/comments`);
    expect(comments.status(), 'the comments went with the image (cascade)').toBe(404);
    for (const url of [image.url, image.previewUrl]) {
      expect((await request.get(url)).status(), `${url} is no longer served`).toBe(404);
    }

    // A reload does not bring it back, and its old address shows "not found".
    await page.goto(`/images/${String(image.id)}`);
    const missing = detailDialog(page, 'Image not found');
    await expect(missing).toBeVisible();
    await expect(missing.getByText('This image does not exist or has been deleted.')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-37, B-47: after the delete the tile goes, loaded pages and scroll position stay, and it is announced', async ({
    page,
  }) => {
    // 13 own images: the oldest one can never be on the first page (12 per page), so it is only in the gallery
    // while the pages loaded with "load more" are kept. The second oldest is deleted.
    const prefix = uniqueTitle('Delete keep pages');
    const images = await createImagesViaApi(page.request, 13, prefix);
    const [, target] = images as [ImageInfo, ImageInfo, ...ImageInfo[]];
    const kept = images.filter((image) => image.id !== target.id);

    await page.goto('/');
    await revealTiles(
      page,
      images.map((image) => image.title),
    );

    const tile = tileLink(page, target.title);
    await tile.scrollIntoViewIfNeeded();
    await expect(tile).toBeInViewport();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore, 'the target tile is below the fold').toBeGreaterThan(0);

    await tile.click();
    const dialog = detailDialog(page, target.title);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(`/images/${String(target.id)}`);
    await deleteImageButton(page).click();
    await confirmDialog(page).getByRole('button', { name: 'delete', exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL('/');
    await expect(tileLink(page, target.title)).toHaveCount(0);
    for (const image of kept) {
      await expect(tileLink(page, image.title), `${image.title} is still loaded`).toHaveCount(1);
    }

    // The deleted tile cannot take focus back; the "Gallery" heading does (ADR 0011). Checked first, so the scroll
    // position below is measured after the focus move, which must not scroll the page either.
    await expect(galleryHeading(page)).toBeFocused();
    expect(await page.evaluate(() => window.scrollY), 'the scroll position is kept').toBe(scrollBefore);
    // Announced in the app's live region once the dialog (and its own region) is gone (F-56).
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /^Image deleted\.$/ })).toHaveCount(1);

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-37, B-56: a failed delete shows the error, keeps the image and can be retried', async ({ page }) => {
    const image = await createImageViaApi(page.request, { title: uniqueTitle('Delete failure') });
    const imagePath = `/api/images/${String(image.id)}`;
    await page.goto('/');
    // Other workers upload at the same time, so the tile may already be past the first page.
    await revealTiles(page, [image.title]);

    // Only the browser's DELETE fails (no response arrives); the image itself stays on the server.
    const isImagePath = (url: URL): boolean => url.pathname === imagePath;
    await page.route(isImagePath, (route) =>
      route.request().method() === 'DELETE' ? route.abort('connectionreset') : route.fallback(),
    );

    await tileLink(page, image.title).click();
    const dialog = detailDialog(page, image.title);
    await expect(dialog).toBeVisible();
    await deleteImageButton(page).click();
    const confirm = confirmDialog(page);
    const confirmButton = confirm.getByRole('button', { name: 'delete', exact: true });
    await confirmButton.click();

    // The confirmation stays open with the reason, so the person can retry or cancel.
    await expect(confirm.getByRole('alert')).toHaveText(SERVICE_UNAVAILABLE);
    await expect(confirmButton).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'cancel', exact: true })).toBeVisible();
    await expectNoA11yViolations(page, { include: 'dialog[open]' });
    expect(await getImageViaApi(page.request, image.id), 'the image still exists').not.toBeNull();

    await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(`/images/${String(image.id)}`);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Retry once the connection works again.
    await page.unroute(isImagePath);
    await deleteImageButton(page).click();
    await confirmDialog(page).getByRole('button', { name: 'delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tileLink(page, image.title)).toHaveCount(0);
    expect(await getImageViaApi(page.request, image.id)).toBeNull();

    await expectNoA11yViolations(page);
  });
});
