import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test';

import { expectNoA11yViolations, expectNoA11yViolationsInBothColorSchemes } from './a11y.ts';
import {
  createImageViaApi,
  E2E_AUTHOR,
  expectProblem,
  getImageViaApi,
  getSessionViaApi,
  type ImageInfo,
  uniqueTitle,
} from './support/api.ts';
import { bigJpeg, imageFixture, notAnImage } from './support/files.ts';
import { galleryHeading, galleryRegion, IMAGES_PATH, tileLink, uploadToggle } from './support/screens.ts';
import { createGate, fulfillInternalError } from './support/stubs.ts';

/**
 * Upload journeys (F-17, F-20, F-24, F-25, F-38; B-12, B-54, B-67) against the production images.
 *
 * Every test opens a fresh page and uploads its own image with a unique title. The gallery is loaded once per page
 * and only this page's upload is prepended client-side, so "first tile" is deterministic even though parallel
 * workers upload into the same stack. Failures and slow uploads are produced with `page.route` (ADR 0015); the
 * size and type limits are read from the stack under test, never hard-coded.
 */

/** Matches the multipart upload only; `GET /api/images?…` (gallery pages) passes untouched. */
const isUploadUrl = (url: URL): boolean => url.pathname === IMAGES_PATH;

function isUploadRequest(request: Request): boolean {
  return request.method() === 'POST' && isUploadUrl(new URL(request.url()));
}

/** Records every upload request the page sends (a held or failed request counts too). */
function recordUploads(page: Page): Request[] {
  const uploads: Request[] = [];
  page.on('request', (request) => {
    if (isUploadRequest(request)) uploads.push(request);
  });
  return uploads;
}

/** Holds every upload request until `release()`; other requests to the same URL pass. */
async function holdUploads(page: Page): Promise<{ release: () => void }> {
  const gate = createGate();
  await page.route(isUploadUrl, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate.opened;
    return route.continue();
  });
  return { release: gate.open };
}

interface UploadForm {
  form: Locator;
  name: Locator;
  title: Locator;
  description: Locator;
  file: Locator;
  submit: Locator;
}

/** The upload form's controls, located by their labels and roles as a person would find them. */
function uploadForm(page: Page): UploadForm {
  const form = page.locator('form', { has: page.getByLabel('Name (shown publicly)', { exact: true }) });
  return {
    form,
    name: form.getByLabel('Name (shown publicly)', { exact: true }),
    title: form.getByLabel('Title', { exact: true }),
    description: form.getByLabel('Description (optional)', { exact: true }),
    // The native file input (role button), named by its visible label plus the visible button text (WCAG 2.5.3).
    file: form.getByRole('button', { name: /^Image choose (an|another) image$/ }),
    submit: form.getByRole('button', { name: /^(upload image|Uploading…)$/ }),
  };
}

/** Loads `/` with a fresh session, waits for the session limits and the gallery, and opens the upload panel. */
async function openUploadForm(page: Page): Promise<UploadForm> {
  const session = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/session' && response.ok(),
  );
  await page.goto('/');
  await session;
  await expect(galleryHeading(page)).toBeVisible();

  const toggle = uploadToggle(page);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const controls = uploadForm(page);
  // Opening moves focus to the first field (UploadPanel).
  await expect(controls.name).toBeFocused();
  return controls;
}

/** The polite app live region (LiveAnnouncer). No dialog is open on these screens, so it is the only one. */
function liveRegion(page: Page): Locator {
  return page.locator('[aria-live="polite"]');
}

/** The first tile link of the gallery. */
function firstTileLink(page: Page): Locator {
  return galleryRegion(page).getByRole('listitem').first().getByRole('link');
}

/** Marks the current document; a reload or a navigation away would drop the attribute. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset['e2eSameDocument'] = 'yes';
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-e2e-same-document', 'yes');
}

/** Waits for the response of the next upload and returns its status and JSON body (the `ImageDto` on `201`). */
async function nextUploadResponse(page: Page): Promise<{ status: number; image: ImageInfo }> {
  const response = await page.waitForResponse((candidate) => isUploadRequest(candidate.request()));
  return { status: response.status(), image: (await response.json()) as ImageInfo };
}

test.describe('upload form', () => {
  test('F-17, F-38, B-12: the form has Name (shown publicly), Title, Description and Image; the upload becomes the first tile without a reload', async ({
    page,
  }) => {
    const title = uniqueTitle('Upload journey');
    const { form, name, title: titleField, description, file, submit } = await openUploadForm(page);

    // F-17: the four fields, by their visible labels.
    await expect(name).toBeVisible();
    await expect(titleField).toBeVisible();
    await expect(description).toBeVisible();
    await expect(form.getByText('Image', { exact: true })).toBeVisible();
    await expect(file).toBeAttached();

    // F-38, B-12: the name is a public display name, nothing suggests an account or a verified identity.
    await expect(form.getByText('Name (shown publicly)', { exact: true })).toBeVisible();
    await expect(name).toHaveAttribute('autocomplete', 'nickname');
    for (const region of [form, page.getByRole('banner')]) {
      await expect(region.getByText(/verified|username|log ?in|sign ?in|sign ?up|account|password/i)).toHaveCount(0);
    }

    await markDocument(page);
    await name.fill(E2E_AUTHOR);
    await titleField.fill(title);
    await description.fill('A flat test image uploaded through the form.');
    await file.setInputFiles(imageFixture('portraitPng'));

    const uploaded = nextUploadResponse(page);
    await submit.click();
    const { status, image } = await uploaded;
    expect(status).toBe(201);
    expect(image.title).toBe(title);
    expect(image.authorName).toBe(E2E_AUTHOR);

    // The new image is the first tile, its preview is served and decodes, and the page was not reloaded.
    const tile = firstTileLink(page);
    await expect(tile).toHaveAccessibleName(title);
    // The tile shows the public name as plain text next to the title.
    await expect(galleryRegion(page).getByRole('listitem').first()).toContainText(E2E_AUTHOR);
    await expect
      .poll(() => tile.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expectSameDocument(page);
    await expect(liveRegion(page)).toHaveText('Image uploaded.');

    await expectNoA11yViolations(page);
  });

  test('F-25: the upload belongs to the uploading session: 201 with canDelete, delete offered to it, not to others', async ({
    page,
    request,
  }) => {
    const title = uniqueTitle('Owned upload');
    const { name, title: titleField, file, submit } = await openUploadForm(page);
    await name.fill(E2E_AUTHOR);
    await titleField.fill(title);
    await file.setInputFiles(imageFixture('squareGif'));

    const uploaded = nextUploadResponse(page);
    await submit.click();
    const { status, image } = await uploaded;
    expect(status).toBe(201);
    expect(image.canDelete).toBe(true);

    // The page's own session owns it; another session sees the same image as foreign.
    expect((await getImageViaApi(page.request, image.id))?.canDelete).toBe(true);
    expect((await getImageViaApi(request, image.id))?.canDelete).toBe(false);

    // The detail dialog of the new tile offers the owner-only delete control.
    await firstTileLink(page).click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'delete image' })).toBeVisible();

    await expectNoA11yViolations(page);
  });
});

test.describe('form UX (F-24)', () => {
  test('F-24, B-67: keyboard only: Enter opens the panel, Tab reaches the file input with a visible focus ring, Space picks a file, Enter uploads', async ({
    page,
  }) => {
    const title = uniqueTitle('Keyboard upload');
    await page.goto('/');
    await expect(galleryHeading(page)).toBeVisible();

    const toggle = uploadToggle(page);
    await toggle.focus();
    await page.keyboard.press('Enter');
    const { name, title: titleField, description, file, submit, form } = uploadForm(page);
    await expect(name).toBeFocused();

    await page.keyboard.type(E2E_AUTHOR);
    await page.keyboard.press('Tab');
    await expect(titleField).toBeFocused();
    await page.keyboard.type(title);
    await page.keyboard.press('Tab');
    await expect(description).toBeFocused();
    await page.keyboard.press('Tab');

    // B-67: the native input is in the tab order, and its visible stand-in shows the focus ring.
    await expect(file).toBeFocused();
    const pickerButton = form.getByText('choose an image', { exact: true });
    await expect(pickerButton).toHaveCSS('outline-style', 'solid');
    await expect(pickerButton).toHaveCSS('outline-width', '2px');

    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await chooser).setFiles(imageFixture('landscapeJpeg'));

    // The chosen file: name and size as text (also the input's description) plus a preview.
    await expect(file).toHaveAccessibleName('Image choose another image');
    await expect(form.getByText(/^landscape\.jpg, /)).toBeVisible();
    await expect(file).toHaveAccessibleDescription(/landscape\.jpg, /);
    await expect(form.locator('img[src^="blob:"]')).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(submit).toBeFocused();
    const uploaded = nextUploadResponse(page);
    await page.keyboard.press('Enter');
    expect((await uploaded).status).toBe(201);

    await expect(liveRegion(page)).toHaveText('Image uploaded.');
    await expect(firstTileLink(page)).toHaveAccessibleName(title);
    // Focus stays on the submit button, it never drops to the page.
    await expect(submit).toBeFocused();

    await expectNoA11yViolations(page);
  });

  test('F-24: Enter in a text field submits the real <form>, and success resets every field including the file', async ({
    page,
  }) => {
    const title = uniqueTitle('Enter submits');
    const { name, title: titleField, description, file, form } = await openUploadForm(page);

    await name.fill(E2E_AUTHOR);
    await description.fill('Sent with the Enter key.');
    await file.setInputFiles(imageFixture('landscapeJpeg'));
    await titleField.fill(title);

    const uploaded = nextUploadResponse(page);
    await titleField.press('Enter');
    expect((await uploaded).status).toBe(201);

    await expect(liveRegion(page)).toHaveText('Image uploaded.');
    await expect(firstTileLink(page)).toHaveAccessibleName(title);

    // B-54 item 1: every field is empty again, the file included, so the next submit cannot resend it.
    await expect(name).toHaveValue('');
    await expect(titleField).toHaveValue('');
    await expect(description).toHaveValue('');
    await expect(file).toHaveValue('');
    await expect(file).toHaveAccessibleName('Image choose an image');
    await expect(form.getByText(/^landscape\.jpg, /)).toHaveCount(0);
    await expect(form.locator('img[src^="blob:"]')).toHaveCount(0);

    await expectNoA11yViolations(page);
  });

  test('F-24: required markers and inline errors linked through aria-invalid and aria-describedby; focus moves to the first invalid field', async ({
    page,
  }) => {
    const uploads = recordUploads(page);
    const { form, name, title, description, file, submit } = await openUploadForm(page);

    // Visible required markers next to Name, Title and Image; Description is optional.
    await expect(form.getByText('required', { exact: true })).toHaveCount(3);
    await expect(name).toHaveAttribute('aria-required', 'true');
    await expect(title).toHaveAttribute('aria-required', 'true');
    await expect(description).not.toHaveAttribute('aria-required', 'true');
    await expect(file).toHaveAttribute('required', '');

    await submit.click();

    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('Enter a name.');
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveAccessibleDescription('Enter a title.');
    await expect(file).toHaveAttribute('aria-invalid', 'true');
    await expect(file).toHaveAccessibleDescription(/^Choose an image to upload\. /);
    await expect(description).not.toHaveAttribute('aria-invalid', 'true');
    for (const message of ['Enter a name.', 'Enter a title.', 'Choose an image to upload.']) {
      await expect(form.getByText(message, { exact: true })).toBeVisible();
    }
    await expect(name).toBeFocused();
    expect(uploads).toHaveLength(0);

    // Whitespace only is empty after trimming (F-18); the first invalid field is now Title.
    await name.fill(E2E_AUTHOR);
    await title.fill('   ');
    await submit.click();
    await expect(title).toBeFocused();
    await expect(title).toHaveAccessibleDescription('Enter a title.');
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');
    expect(uploads).toHaveLength(0);

    await expectNoA11yViolationsInBothColorSchemes(page);
  });

  test('F-24, B-54: while uploading the submit reads "Uploading…", is busy and keeps focus; presses and Enter do not upload twice', async ({
    page,
  }) => {
    const title = uniqueTitle('Single upload');
    const edited = uniqueTitle('Typed while uploading');
    const uploads = recordUploads(page);
    const { name, title: titleField, description, file, submit } = await openUploadForm(page);
    const held = await holdUploads(page);

    await name.fill(E2E_AUTHOR);
    await titleField.fill(title);
    await description.fill('Only one upload, please.');
    await file.setInputFiles(imageFixture('landscapeJpeg'));
    await submit.focus();
    await page.keyboard.press('Enter');

    await expect(submit).toHaveText('Uploading…');
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await expect(submit).toBeFocused();
    await expect.poll(() => uploads.length).toBe(1);

    // Double submit attempts: Enter and a click on the busy button, and Enter in a text field. The busy button is
    // `aria-disabled`, so Playwright's actionability check would refuse the click; `force` dispatches it anyway,
    // because a press on the busy button is exactly what must not upload again.
    await page.keyboard.press('Enter');
    await submit.click({ force: true });
    await name.press('Enter');
    // R-10: the fields stay editable; a value entered while the upload runs is the start of the next upload.
    await titleField.fill(edited);

    const uploaded = nextUploadResponse(page);
    held.release();
    const { status, image } = await uploaded;
    expect(status).toBe(201);
    expect(image.title).toBe(title);

    await expect(liveRegion(page)).toHaveText('Image uploaded.');
    await expect(submit).toHaveText('upload image');
    await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
    expect(uploads).toHaveLength(1);
    await expect(tileLink(page, title)).toHaveCount(1);

    // Sent values are reset, the one typed meanwhile is kept.
    await expect(name).toHaveValue('');
    await expect(description).toHaveValue('');
    await expect(file).toHaveValue('');
    await expect(titleField).toHaveValue(edited);

    await expectNoA11yViolations(page);
  });

  test('F-24, B-54: a failed upload shows an alert and keeps every value including the file; retrying succeeds', async ({
    page,
  }) => {
    const title = uniqueTitle('Retry upload');
    const uploads = recordUploads(page);
    const { form, name, title: titleField, description, file, submit } = await openUploadForm(page);

    await page.route(isUploadUrl, async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return fulfillInternalError(route);
    });

    await name.fill(E2E_AUTHOR);
    await titleField.fill(title);
    await description.fill('The first attempt fails.');
    await file.setInputFiles(imageFixture('portraitPng'));
    await submit.click();

    await expect(form.getByRole('alert')).toHaveText('An unexpected error occurred.');
    await expect(submit).toHaveText('upload image');
    await expect(name).toHaveValue(E2E_AUTHOR);
    await expect(titleField).toHaveValue(title);
    await expect(description).toHaveValue('The first attempt fails.');
    await expect(file).not.toHaveValue('');
    await expect(form.getByText(/^portrait\.png, /)).toBeVisible();
    await expect(tileLink(page, title)).toHaveCount(0);
    await expectNoA11yViolations(page);

    // The kept values are enough to try again: nothing is re-entered.
    await page.unrouteAll({ behavior: 'wait' });
    const uploaded = nextUploadResponse(page);
    await submit.click();
    const { status, image } = await uploaded;
    expect(status).toBe(201);
    expect(image.title).toBe(title);
    expect(image.width).toBe(imageFixture('portraitPng').width);
    expect(uploads).toHaveLength(2);

    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(firstTileLink(page)).toHaveAccessibleName(title);
    await expect(liveRegion(page)).toHaveText('Image uploaded.');

    await expectNoA11yViolations(page);
  });
});

test.describe('file limits (F-20)', () => {
  test('F-20: the API behind nginx accepts exactly UPLOAD_MAX_BYTES and answers 413 problem+json one byte over', async ({
    request,
  }) => {
    const { uploadMaxBytes } = await getSessionViaApi(request);

    const atLimit = await createImageViaApi(request, {
      title: uniqueTitle('Exactly at the limit'),
      file: bigJpeg(uploadMaxBytes),
    });
    expect(atLimit.mimeType).toBe('image/jpeg');

    const { csrfToken } = await getSessionViaApi(request);
    const response = await request.post('/api/images', {
      headers: { 'x-csrf-token': csrfToken },
      multipart: { authorName: E2E_AUTHOR, title: uniqueTitle('One byte over'), file: bigJpeg(uploadMaxBytes + 1) },
    });
    const problem = await expectProblem(response, 413, 'payload-too-large');
    expect(problem.detail).toMatch(/^The image must be \d+(\.\d)? MB or smaller\.$/);
  });

  test("F-20, B-54: the browser rejects a too large file and a non-image before sending, with the API's own messages", async ({
    page,
    request,
  }) => {
    // The API's messages for the same files: the client must show exactly these (F-20).
    const { uploadMaxBytes, csrfToken } = await getSessionViaApi(request);
    const tooLarge = await request.post('/api/images', {
      headers: { 'x-csrf-token': csrfToken },
      multipart: { authorName: E2E_AUTHOR, title: uniqueTitle('Too large'), file: bigJpeg(uploadMaxBytes + 1) },
    });
    expect(tooLarge.status()).toBe(413);
    const tooLargeMessage = ((await tooLarge.json()) as { detail: string }).detail;
    const disguised = await request.post('/api/images', {
      headers: { 'x-csrf-token': (await getSessionViaApi(request)).csrfToken },
      multipart: { authorName: E2E_AUTHOR, title: uniqueTitle('Disguised HTML'), file: notAnImage() },
    });
    expect(disguised.status()).toBe(415);
    const wrongTypeMessage = ((await disguised.json()) as { detail: string }).detail;
    expect(wrongTypeMessage).toBe('Only JPEG, PNG, WebP or GIF images are allowed.');

    const uploads = recordUploads(page);
    const { form, name, title, file, submit } = await openUploadForm(page);
    const limit = /(\d+(\.\d)? MB)/.exec(tooLargeMessage)?.[1] ?? '<no size in the 413 detail>';

    // The picker states the accepted types and the stack's limit; `accept` is only a hint for the system dialog.
    await expect(file).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/gif');
    await expect(file).toHaveAccessibleDescription(`JPEG, PNG, WebP or GIF, up to ${limit}.`);

    await name.fill(E2E_AUTHOR);
    await title.fill(uniqueTitle('Never sent'));

    await file.setInputFiles(bigJpeg(uploadMaxBytes + 1));
    await expect(form.getByText(tooLargeMessage, { exact: true })).toBeVisible();
    await expect(file).toHaveAttribute('aria-invalid', 'true');
    await expect(file).toHaveAccessibleDescription(new RegExp(`^${RegExp.escape(tooLargeMessage)} `));
    await expect(form.locator('img[src^="blob:"]')).toHaveCount(0);
    await submit.click();
    await expect(file).toBeFocused();

    await file.setInputFiles(notAnImage());
    await expect(form.getByText(wrongTypeMessage, { exact: true })).toBeVisible();
    await expect(form.getByText(tooLargeMessage, { exact: true })).toHaveCount(0);
    await expect(file).toHaveAttribute('aria-invalid', 'true');
    await submit.click();
    await expect(file).toBeFocused();
    expect(uploads).toHaveLength(0);

    // A valid image clears the error and shows its preview.
    await file.setInputFiles(imageFixture('squareGif'));
    await expect(form.getByText(wrongTypeMessage, { exact: true })).toHaveCount(0);
    await expect(file).not.toHaveAttribute('aria-invalid', 'true');
    await expect(form.locator('img[src^="blob:"]')).toBeVisible();

    await expectNoA11yViolations(page);
  });
});
